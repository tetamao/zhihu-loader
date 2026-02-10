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

		// 1. 侧边栏核心按钮：一键同步所有回答
		this.addRibbonIcon("refresh-cw", "一键同步我的所有回答", () =>
			this.syncAllMyAnswers(),
		);

		// 2. 备用按钮：导入单个回答
		this.addRibbonIcon("link", "导入单个回答", () =>
			this.showImportModal(),
		);

		this.addSettingTab(new ZhihuSettingTab(this.app, this));
	}

	// --- 核心：全量一键同步逻辑 ---
	async syncAllMyAnswers() {
		const userId = this.settings.zhihuId;
		if (!userId) {
			new Notice("❌ 报错：请先在设置中填写你的用户 ID");
			return;
		}

		new Notice("🔍 正在连接知乎，调取你的回答列表...");
		try {
			// 这里 limit=20 可以根据需要调大，知乎 API 单次支持到 20
			const url = `https://www.zhihu.com/api/v4/members/${userId}/answers?order_by=created&offset=0&limit=20`;
			const res = await requestUrl({
				url: url,
				method: "GET",
				headers: {
					Cookie: this.settings.cookie,
					"User-Agent":
						"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
				},
			});

			const items = res.json.data;
			if (!items || items.length === 0) {
				new Notice("⚠️ 没抓到内容！请检查 ID 或 Cookie 是否失效");
				return;
			}

			new Notice(`🚀 发现 ${items.length} 个回答，开始全量高清同步...`);

			let successCount = 0;
			for (const item of items) {
				const answerUrl = `https://www.zhihu.com/question/${item.question.id}/answer/${item.id}`;
				try {
					await this.fetchZhihuAnswer(answerUrl);
					successCount++;
				} catch (err) {
					console.error(`同步失败: ${answerUrl}`, err);
				}
			}
			new Notice(`✅ 任务完成！共一键同步了 ${successCount} 个回答`);
		} catch (e) {
			console.error(e);
			new Notice("❌ 同步中断！请检查网络或 Cookie 权限");
		}
	}

	// --- 核心：单条回答抓取逻辑 (包含高清、去重、所有元数据) ---
	async fetchZhihuAnswer(cleanUrl: string) {
		const answerId = cleanUrl.match(/answer\/(\d+)/)?.[1];
		if (!answerId) return;

		try {
			const response = await requestUrl({
				url: `https://www.zhihu.com/api/v4/answers/${answerId}?include=content,author,question,voteup_count,comment_count,thanks_count,created_time,updated_time`,
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
			const assetFolder = `${this.settings.downloadFolder}/attachments`;

			if (!(await vault.adapter.exists(this.settings.downloadFolder)))
				await vault.createFolder(this.settings.downloadFolder);
			if (!(await vault.adapter.exists(assetFolder)))
				await vault.createFolder(assetFolder);

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

				// 终极无水印还原：截断所有参数
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

			// 找回所有元数据：标题、URL、作者、点赞、评论、日期
			const fileContent = [
				`---`,
				`标题: "${apiTitle.replace(/"/g, '\\"')}"`,
				`url: ${cleanUrl}`,
				`作者: ${data.author.name}`,
				`点赞数: ${data.voteup_count}`,
				`评论数: ${data.comment_count}`,
				`回答日期: ${new Date(data.created_time * 1000).toISOString().split("T")[0]}`,
				`最后更新: ${new Date(data.updated_time * 1000).toISOString().split("T")[0]}`,
				`导入日期: ${new Date().toISOString().split("T")[0]}`,
				`---`,
				`# ${apiTitle}\n\n${markdownBody}`,
			].join("\n");

			const safeFileName = apiTitle.replace(/[\\/:*?"<>|]/g, "-");
			const filePath = `${this.settings.downloadFolder}/${safeFileName}.md`;

			const existingFile = vault.getAbstractFileByPath(filePath);
			if (existingFile instanceof TFile) {
				await vault.modify(existingFile, fileContent);
			} else {
				await vault.create(filePath, fileContent);
			}
		} catch (error) {
			console.error("抓取失败", cleanUrl);
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
		new Setting(containerEl).setName("保存文件夹").addText((t) =>
			t
				.setValue(this.plugin.settings.downloadFolder)
				.onChange(async (v) => {
					this.plugin.settings.downloadFolder = v;
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
