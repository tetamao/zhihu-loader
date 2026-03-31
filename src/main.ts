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
}

const DEFAULT_SETTINGS: ZhihuSettings = {
	downloadFolder: "Zhihu_Imports",
	cookie: "",
	zhihuId: "",
};

export default class ZhihuLoaderPlugin extends Plugin {
	settings: ZhihuSettings;

	async onload() {
		await this.loadSettings();

		// 图标 1：全量/增量同步回答
		this.addRibbonIcon("refresh-cw", "一键同步我的所有回答", () =>
			this.syncAllMyAnswers(),
		);

		// 图标 2：导入单个回答链接
		this.addRibbonIcon("link", "导入单个回答", () =>
			this.showImportModal(),
		);

		this.addSettingTab(new ZhihuSettingTab(this.app, this));
	}

	/**
	 * 全量同步逻辑：支持分页与智能熔断
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
							new Notice(
								"✨ 检测到本地已有最新内容，同步已自动熔断。",
							);
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

			new Notice(`✅ 同步完成！本次处理: ${totalSuccess} 条`);
		} catch (e) {
			console.error(e);
			new Notice("❌ 同步中断！请检查网络或 Cookie");
		}
	}

	/**
	 * 核心抓取函数：包含图片本地化和目录创建
	 */
	async fetchZhihuAnswer(
		cleanUrl: string,
	): Promise<"SUCCESS" | "SKIPPED" | "FAILED"> {
		const answerId = cleanUrl.match(/answer\/(\d+)/)?.[1];
		if (!answerId) return "FAILED";

		try {
			const response = await requestUrl({
				url: `https://www.zhihu.com/api/v4/answers/${answerId}?include=content,author,question,voteup_count,comment_count,created_time,updated_time,question.topics`,
				method: "GET",
				headers: {
					"User-Agent":
						"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
					Cookie: this.settings.cookie,
					Referer: "https://www.zhihu.com/",
				},
			});

			const data = response.json;
			const apiTitle = data.question.title;
			const vault = this.app.vault;

			const baseFolder = this.settings.downloadFolder;
			const answerFolder = `${baseFolder}/answers`;
			const assetFolder = `${baseFolder}/attachments`;

			if (!(await vault.adapter.exists(baseFolder)))
				await vault.createFolder(baseFolder);
			if (!(await vault.adapter.exists(answerFolder)))
				await vault.createFolder(answerFolder);
			if (!(await vault.adapter.exists(assetFolder)))
				await vault.createFolder(assetFolder);

			const safeFileName = apiTitle.replace(/[\\/:*?"<>|]/g, "-");
			const filePath = `${answerFolder}/${safeFileName}.md`;

			const stats = await vault.adapter.stat(filePath);
			if (stats) {
				const zhihuUpdateTime = data.updated_time * 1000;
				if (stats.mtime >= zhihuUpdateTime) return "SKIPPED";
			}

			const parser = new DOMParser();
			const doc = parser.parseFromString(data.content, "text/html");
			const processedImages = new Set<string>();
			let imageIndex = 0;

			const imgs = Array.from(doc.querySelectorAll("img"));
			for (const img of imgs) {
				let rawSrc =
					img.getAttribute("data-actualsrc") ||
					img.getAttribute("data-original") ||
					img.getAttribute("src");
				if (!rawSrc || rawSrc.includes("data:image/svg+xml")) {
					img.remove();
					continue;
				}

				let hdSrc = rawSrc
					.split("?")[0]
					.replace(/_[a-z0-9]+(\.(jpg|png|webp|jpeg|gif))/gi, "$1");
				const imageId = hdSrc.split("/").pop() || hdSrc;

				if (processedImages.has(imageId)) {
					const ext = hdSrc.split(".").pop() || "jpg";
					img.setAttribute(
						"src",
						`zhihu_${answerId}_${Array.from(processedImages).indexOf(imageId)}.${ext}`,
					);
					continue;
				}

				try {
					const imgRes = await requestUrl({
						url: hdSrc,
						method: "GET",
					});
					const ext = hdSrc.split(".").pop() || "jpg";
					const imgName = `zhihu_${answerId}_${imageIndex}.${ext}`;
					const imgPath = `${assetFolder}/${imgName}`;
					if (!(await vault.adapter.exists(imgPath)))
						await vault.createBinary(imgPath, imgRes.arrayBuffer);
					img.setAttribute("src", imgName);
					processedImages.add(imageId);
					imageIndex++;
				} catch (e) {
					console.error("图片下载失败", hdSrc);
				}
			}

			const turndownService = new TurndownService({
				headingStyle: "atx",
				bulletListMarker: "-",
			});
			turndownService.addRule("zhihu-img", {
				filter: "img",
				replacement: (content, node: any) => {
					const src = node.getAttribute("src");
					return src && !src.startsWith("http") ? `![[${src}]]` : "";
				},
			});
			doc.querySelectorAll("noscript, script, style").forEach((el) =>
				el.remove(),
			);
			const markdownBody = turndownService.turndown(doc.body.innerHTML);

			const topics: string[] =
				data.question.topics?.map((t: any) => t.name) || [];
			const linkedTopics = topics.map((t) => `'[[${t}]]'`).join(", ");

			const fileContent = [
				`---`,
				`标题: "${apiTitle.replace(/"/g, '\\"')}"`,
				`url: ${cleanUrl}`,
				`作者: ${data.author.name}`,
				`话题: [${linkedTopics}]`,
				`点赞数: ${data.voteup_count}`,
				`回答日期: ${new Date(data.created_time * 1000).toISOString().split("T")[0]}`,
				`导入日期: ${new Date().toISOString().split("T")[0]}`,
				`---`,
				`# ${apiTitle}\n\n${markdownBody}`,
			].join("\n");

			const existingFile = vault.getAbstractFileByPath(filePath);
			if (existingFile instanceof TFile) {
				await vault.modify(existingFile, fileContent);
			} else {
				await vault.create(filePath, fileContent);
			}
			return "SUCCESS";
		} catch (error) {
			return "FAILED";
		}
	}

	/**
	 * 创作者推荐抓取逻辑
	 */
	async fetchCreatorRecommendQuestions() {
		if (!this.settings.cookie) {
			new Notice("❌ 无法抓取：请先填写知乎 Cookie");
			return;
		}

		new Notice("🔍 正在从创作者中心获取推荐...");

		try {
			const res = await requestUrl({
				url: "https://www.zhihu.com/api/v4/creators/question_route/author_related/recommend?limit=20&offset=0&page_source=web_author_recommend&recom_domain_score_ab=1",
				method: "GET",
				headers: {
					Cookie: this.settings.cookie,
					"User-Agent":
						"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
				},
			});

			const items = res.json.data;
			if (!items || items.length === 0) {
				new Notice(
					"⚠️ 未发现推荐问题，请确认 Cookie 是否包含创作者权限",
				);
				return;
			}

			const vault = this.app.vault;
			const baseFolder = this.settings.downloadFolder;
			const recommendFolder = `${baseFolder}/recommend`;

			if (!(await vault.adapter.exists(baseFolder)))
				await vault.createFolder(baseFolder);
			if (!(await vault.adapter.exists(recommendFolder)))
				await vault.createFolder(recommendFolder);

			let tableContent = `## 创作者中心推荐列表\n生成时间: ${new Date().toLocaleString()}\n\n`;
			tableContent +=
				"| 问题标题 | 推荐理由 | 提问者 | 回答数 | 链接 |\n| :--- | :--- | :--- | :--- | :--- |\n";

			for (const item of items) {
				const q = item.question;
				if (!q) continue;
				tableContent += `| ${q.title.replace(/\|/g, "\\|")} | ${item.reason || "系统推荐"} | ${q.author?.name || "匿名"} | ${q.answer_count} | [查看问题](https://www.zhihu.com/question/${q.id}) |\n`;
			}

			const filePath = `${recommendFolder}/创作者推荐_${new Date().toISOString().split("T")[0]}.md`;
			const existingFile = vault.getAbstractFileByPath(filePath);
			if (existingFile instanceof TFile) {
				await vault.modify(existingFile, tableContent);
			} else {
				await vault.create(filePath, tableContent);
			}

			new Notice(`✅ 推荐获取成功！已保存至 ${filePath}`);
			const file = vault.getAbstractFileByPath(filePath);
			if (file instanceof TFile)
				this.app.workspace.getLeaf().openFile(file);
		} catch (e) {
			console.error(e);
			new Notice("❌ 获取推荐失败，请检查网络");
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

		new Setting(containerEl)
			.setName("我的 ID (People ID)")
			.setDesc("主页 URL 中 people/ 后面那一串")
			.addText((t) =>
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

		// --- 交互优化：将抓取按钮放在设置页 ---
		new Setting(containerEl)
			.setName("立即抓取推荐问题")
			.setDesc("从知乎创作者中心抓取最新的推荐问题并生成表格。")
			.addButton((btn) =>
				btn
					.setButtonText("开始抓取")
					.setCta()
					.onClick(async () => {
						await this.plugin.fetchCreatorRecommendQuestions();
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
