import {
	App,
	Modal,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	requestUrl,
	TFile,
} from "obsidian";
import TurndownService from "turndown";

interface ZhihuSettings {
	downloadFolder: string;
	cookie: string;
	zhihuId: string;
	enableRecommendSync: boolean;
	enableGoodsSync: boolean;
}

const DEFAULT_SETTINGS: ZhihuSettings = {
	downloadFolder: "Zhihu_Imports",
	cookie: "",
	zhihuId: "",
	enableRecommendSync: false,
	enableGoodsSync: false,
};

export default class ZhihuLoaderPlugin extends Plugin {
	settings: ZhihuSettings;

	async onload() {
		await this.loadSettings();

		// 侧边栏图标
		this.addRibbonIcon("refresh-cw", "一键同步我的所有回答", () =>
			this.syncAllMyAnswers(),
		);

		this.addRibbonIcon("link", "导入单个回答", () =>
			this.showImportModal(),
		);

		// 命令面板独立触发
		this.addCommand({
			id: "fetch-zhihu-recommendation-only",
			name: "获取今日创作者中心推荐",
			callback: () => this.fetchCreatorRecommendQuestions(),
		});

		this.addCommand({
			id: "fetch-zhihu-goods-recommendation-only",
			name: "获取今日好物推荐问题",
			callback: () => this.fetchGoodsRecommendQuestions(),
		});

		this.addSettingTab(new ZhihuSettingTab(this.app, this));
	}

	/**
	 * 同步主入口
	 */
	async syncAllMyAnswers() {
		const userId = this.settings.zhihuId;
		if (!userId) {
			new Notice("❌ 报错：请先在设置中填写你的用户 ID");
			return;
		}

		new Notice("🔍 正在启动增量同步...");

		let offset = 0;
		let isEnd = false;
		let totalSuccess = 0;

		try {
			// 1. 同步回答
			while (!isEnd) {
				const url = `https://www.zhihu.com/api/v4/members/${userId}/answers?order_by=created&offset=${offset}&limit=20&include=data%5B*%5D.target.question.topics`;
				const res = await requestUrl({
					url: url,
					method: "GET",
					headers: {
						Cookie: this.settings.cookie,
						"User-Agent":
							"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
					},
				});

				const data = res.json;
				const items = data.data;
				if (!items || items.length === 0) break;

				for (const item of items) {
					const answerUrl = `https://www.zhihu.com/question/${item.question.id}/answer/${item.id}`;
					try {
						const result = await this.fetchZhihuAnswer(answerUrl);
						if (result === "SKIPPED") {
							new Notice("✨ 检测到本地内容已是最新。");
							isEnd = true;
							break;
						}
						if (result === "SUCCESS") totalSuccess++;
					} catch (err) {
						console.error(`同步失败: ${answerUrl}`, err);
					}
				}
				if (isEnd) break;
				isEnd = data.paging.is_end;
				offset += 20;
				await new Promise((resolve) => setTimeout(resolve, 1000));
			}

			new Notice(`✅ 回答同步完成！新增: ${totalSuccess} 条`);

			// 2. 联动：创作者推荐
			if (this.settings.enableRecommendSync) {
				await this.fetchCreatorRecommendQuestions();
			}

			// 3. 联动：好物推荐 (2.0 核心)
			if (this.settings.enableGoodsSync) {
				await this.fetchGoodsRecommendQuestions();
			}
		} catch (e) {
			new Notice("❌ 同步中断！请检查网络或 Cookie");
		}
	}

	/**
	 * 【2.0 修复】好物推荐抓取 - 基于截图 API 修改
	 */
	async fetchGoodsRecommendQuestions() {
		if (!this.settings.cookie) {
			new Notice("⚠️ 请先设置知乎 Cookie");
			return;
		}

		try {
			// 使用截图中的 API 路径
			const url =
				"https://www.zhihu.com/api/v4/mcn/recommend/question?tab_id=0&offset=0&limit=20";

			const res = await requestUrl({
				url: url,
				method: "GET",
				headers: {
					Cookie: this.settings.cookie,
					"User-Agent":
						"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
					Referer:
						"https://www.zhihu.com/creator/content-growth/mcn-question",
				},
			});

			const items = res.json.data;
			if (!items || items.length === 0) {
				new Notice("⚠️ 好物 API 未返回有效数据，请检查 Cookie 权限");
				return;
			}

			const vault = this.app.vault;
			const base = this.settings.downloadFolder;
			const goodsPath = `${base}/Goods`;

			// 严谨的文件夹分级创建
			if (!(await vault.adapter.exists(base)))
				await vault.createFolder(base);
			if (!(await vault.adapter.exists(goodsPath)))
				await vault.createFolder(goodsPath);

			let md = `## 知乎好物推荐列表 (${new Date().toLocaleDateString()})\n\n`;
			md +=
				"| 问题标题 | 回答数 | 浏览量 | 链接 |\n| :--- | :--- | :--- | :--- |\n";

			items.forEach((item: any) => {
				const q = item.question || item; // 适配不同 API 返回层级
				if (!q.title) return;
				const title = q.title.replace(/\|/g, "\\|");
				const link = `https://www.zhihu.com/question/${q.id}`;
				const answers = q.answer_count || 0;
				const views = q.visit_count || "N/A";
				md += `| ${title} | ${answers} | ${views} | [查看详情](${link}) |\n`;
			});

			const fileName = `${goodsPath}/好物推荐_${new Date().toISOString().split("T")[0]}.md`;
			const file = vault.getAbstractFileByPath(fileName);

			if (file instanceof TFile) {
				await vault.modify(file, md);
			} else {
				await vault.create(fileName, md);
			}
			new Notice("✅ 好物清单同步成功 (Goods 文件夹)");
		} catch (e) {
			console.error("Goods Sync Error:", e);
			new Notice("❌ 好物推荐抓取失败，请在控制台查看详情");
		}
	}

	/**
	 * 创作者推荐 (V1.1 逻辑)
	 */
	async fetchCreatorRecommendQuestions() {
		if (!this.settings.cookie) return;
		try {
			const res = await requestUrl({
				url: "https://www.zhihu.com/api/v4/creators/question_route/author_related/recommend?limit=20&offset=0&page_source=web_author_recommend",
				method: "GET",
				headers: { Cookie: this.settings.cookie },
			});
			const items = res.json.data;
			if (!items || items.length === 0) return;

			const vault = this.app.vault;
			const folder = `${this.settings.downloadFolder}/recommend`;
			if (!(await vault.adapter.exists(this.settings.downloadFolder)))
				await vault.createFolder(this.settings.downloadFolder);
			if (!(await vault.adapter.exists(folder)))
				await vault.createFolder(folder);

			let md = `## 创作者推荐 (${new Date().toLocaleDateString()})\n\n| 标题 | 回答数 | 链接 |\n| :--- | :--- | :--- |\n`;
			items.forEach((item: any) => {
				const q = item.question;
				if (q)
					md += `| ${q.title.replace(/\|/g, "\\|")} | ${q.answer_count} | [详情](https://www.zhihu.com/question/${q.id}) |\n`;
			});

			const fileName = `${folder}/创作者推荐_${new Date().toISOString().split("T")[0]}.md`;
			const file = vault.getAbstractFileByPath(fileName);
			if (file instanceof TFile) await vault.modify(file, md);
			else await vault.create(fileName, md);
			new Notice("✅ 创作者推荐同步成功");
		} catch (e) {}
	}

	/**
	 * 单个回答抓取 (V1 核心 - 包含图片下载)
	 */
	async fetchZhihuAnswer(
		cleanUrl: string,
	): Promise<"SUCCESS" | "SKIPPED" | "FAILED"> {
		const answerId = cleanUrl.match(/answer\/(\d+)/)?.[1];
		if (!answerId) return "FAILED";

		try {
			const response = await requestUrl({
				url: `https://www.zhihu.com/api/v4/answers/${answerId}?include=content,author,question,updated_time,created_time,question.topics`,
				method: "GET",
				headers: {
					"User-Agent":
						"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
					Cookie: this.settings.cookie,
				},
			});

			const data = response.json;
			const apiTitle = data.question.title;
			const vault = this.app.vault;
			const base = this.settings.downloadFolder;
			const answerDir = `${base}/answers`;
			const assetDir = `${base}/attachments`;

			if (!(await vault.adapter.exists(base)))
				await vault.createFolder(base);
			if (!(await vault.adapter.exists(answerDir)))
				await vault.createFolder(answerDir);
			if (!(await vault.adapter.exists(assetDir)))
				await vault.createFolder(assetDir);

			const safeName = apiTitle.replace(/[\\/:*?"<>|]/g, "-");
			const path = `${answerDir}/${safeName}.md`;
			const stats = await vault.adapter.stat(path);
			if (stats && stats.mtime >= data.updated_time * 1000)
				return "SKIPPED";

			const parser = new DOMParser();
			const doc = parser.parseFromString(data.content, "text/html");
			const imgs = Array.from(doc.querySelectorAll("img"));
			const processed = new Set<string>();
			let idx = 0;

			for (const img of imgs) {
				let src =
					img.getAttribute("data-actualsrc") ||
					img.getAttribute("data-original") ||
					img.getAttribute("src");
				if (!src || src.includes("data:image/svg+xml")) {
					img.remove();
					continue;
				}
				let hd = src
					.split("?")[0]
					.replace(/_[a-z0-9]+(\.(jpg|png|webp|jpeg|gif))/gi, "$1");
				const id = hd.split("/").pop() || hd;
				if (processed.has(id)) continue;

				try {
					const res = await requestUrl({ url: hd, method: "GET" });
					const ext = hd.split(".").pop() || "jpg";
					const name = `zhihu_${answerId}_${idx}.${ext}`;
					await vault.createBinary(
						`${assetDir}/${name}`,
						res.arrayBuffer,
					);
					img.setAttribute("src", name);
					processed.add(id);
					idx++;
				} catch (e) {}
			}

			const turndown = new TurndownService({
				headingStyle: "atx",
				bulletListMarker: "-",
			});
			turndown.addRule("zhihu-img", {
				filter: "img",
				replacement: (content, node: any) => {
					const s = node.getAttribute("src");
					return s && !s.startsWith("http") ? `![[${s}]]` : "";
				},
			});
			const body = turndown.turndown(doc.body.innerHTML);
			const topics =
				data.question.topics
					?.map((t: any) => `'[[${t.name}]]'`)
					.join(", ") || "";

			const content = [
				`---`,
				`标题: "${apiTitle.replace(/"/g, '\\"')}"`,
				`url: ${cleanUrl}`,
				`话题: [${topics}]`,
				`日期: ${new Date(data.created_time * 1000).toISOString().split("T")[0]}`,
				`---`,
				`# ${apiTitle}\n\n${body}`,
			].join("\n");

			const file = vault.getAbstractFileByPath(path);
			if (file instanceof TFile) await vault.modify(file, content);
			else await vault.create(path, content);
			return "SUCCESS";
		} catch (error) {
			return "FAILED";
		}
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData(),
		);
	}
	async saveSettings() {
		await this.saveData(this.settings);
	}
	showImportModal() {
		const modal = new ImportModal(this.app, async (url) => {
			if (url) await this.fetchZhihuAnswer(url);
		});
		modal.open();
	}
}

class ZhihuSettingTab extends PluginSettingTab {
	plugin: ZhihuLoaderPlugin;
	constructor(app: App, plugin: ZhihuLoaderPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}
	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		new Setting(containerEl).setName("知乎 Cookie").addTextArea((t) =>
			t.setValue(this.plugin.settings.cookie).onChange(async (v) => {
				this.plugin.settings.cookie = v;
				await this.plugin.saveSettings();
			}),
		);
		new Setting(containerEl).setName("我的 ID (People ID)").addText((t) =>
			t.setValue(this.plugin.settings.zhihuId).onChange(async (v) => {
				this.plugin.settings.zhihuId = v;
				await this.plugin.saveSettings();
			}),
		);
		new Setting(containerEl).setName("根目录名称").addText((t) =>
			t
				.setValue(this.plugin.settings.downloadFolder)
				.onChange(async (v) => {
					this.plugin.settings.downloadFolder = v;
					await this.plugin.saveSettings();
				}),
		);
		new Setting(containerEl)
			.setName("同步时抓取创作者推荐")
			.addToggle((t) =>
				t
					.setValue(this.plugin.settings.enableRecommendSync)
					.onChange(async (v) => {
						this.plugin.settings.enableRecommendSync = v;
						await this.plugin.saveSettings();
					}),
			);
		new Setting(containerEl)
			.setName("同步时抓取好物推荐")
			.setDesc("开启后将在 Goods 文件夹生成清单")
			.addToggle((t) =>
				t
					.setValue(this.plugin.settings.enableGoodsSync)
					.onChange(async (v) => {
						this.plugin.settings.enableGoodsSync = v;
						await this.plugin.saveSettings();
					}),
			);
	}
}

class ImportModal extends Modal {
	url: string = "";
	onSubmit: (url: string) => void;
	constructor(app: App, onSubmit: (url: string) => void) {
		super(app);
		this.onSubmit = onSubmit;
	}
	onOpen() {
		const { contentEl } = this;
		contentEl.createEl("h2", { text: "导入单个回答" });
		new Setting(contentEl)
			.setName("链接")
			.addText((text) => text.onChange((v) => (this.url = v)));
		new Setting(contentEl).addButton((b) =>
			b
				.setButtonText("开始")
				.setCta()
				.onClick(() => {
					this.close();
					this.onSubmit(this.url);
				}),
		);
	}
}
