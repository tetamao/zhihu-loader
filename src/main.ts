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

		this.addRibbonIcon("refresh-cw", "一键同步我的所有回答", () =>
			this.syncAllMyAnswers(),
		);

		this.addRibbonIcon("link", "导入单个回答", () =>
			this.showImportModal(),
		);

		this.addSettingTab(new ZhihuSettingTab(this.app, this));
	}

	async syncAllMyAnswers() {
		const userId = this.settings.zhihuId;
		if (!userId) {
			new Notice("❌ 报错：请先在设置中填写你的用户 ID");
			return;
		}

		new Notice("🔍 正在启动全量同步，请保持网络畅通...");

		let offset = 0;
		let isEnd = false;
		let totalSuccess = 0;

		try {
			while (!isEnd) {
				// 增加 include 参数以确保获取话题数据，增加 limit 和 offset 实现分页
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

				new Notice(
					`逐步抓取中：正在处理第 ${offset + 1} - ${offset + items.length} 条回答...`,
				);

				for (const item of items) {
					const answerUrl = `https://www.zhihu.com/question/${item.question.id}/answer/${item.id}`;
					try {
						await this.fetchZhihuAnswer(answerUrl);
						totalSuccess++;
					} catch (err) {
						console.error(`同步失败: ${answerUrl}`, err);
					}
				}

				// 更新分页状态
				isEnd = data.paging.is_end;
				offset += 20;

				// 适当延时，防止触发知乎频率限制
				await new Promise((resolve) => setTimeout(resolve, 1000));
			}

			new Notice(`✅ 全量同步完成！共导入 ${totalSuccess} 个回答`);
		} catch (e) {
			console.error(e);
			new Notice("❌ 同步中断！请检查网络或 Cookie");
		}
	}

	async fetchZhihuAnswer(cleanUrl: string) {
		const answerId = cleanUrl.match(/answer\/(\d+)/)?.[1];
		if (!answerId) return;

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

			// --- 路径逻辑：固定为 answers 和 attachments ---
			const baseFolder = this.settings.downloadFolder;
			const answerFolder = `${baseFolder}/answers`; //存放回答
			const assetFolder = `${baseFolder}/attachments`; //存放图片

			if (!(await vault.adapter.exists(baseFolder)))
				await vault.createFolder(baseFolder);
			if (!(await vault.adapter.exists(answerFolder)))
				await vault.createFolder(answerFolder);
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

			// 提取话题并处理为带引号的双链格式
			const topics: string[] =
				data.question.topics?.map((t: any) => t.name) || [];

			// 关键改动：在 [[ ]] 外面加上单引号 ' '
			const linkedTopics = topics.map((t) => `'[[${t}]]'`).join(", ");

			const fileContent = [
				`---`,
				`标题: "${apiTitle.replace(/"/g, '\\"')}"`,
				`url: ${cleanUrl}`,
				`作者: ${data.author.name}`,
				`话题: [${linkedTopics}]`, // 推荐写成数组格式 [ '[[话题1]]', '[[话题2]]' ]
				`点赞数: ${data.voteup_count}`,
				`回答日期: ${new Date(data.created_time * 1000).toISOString().split("T")[0]}`,
				`导入日期: ${new Date().toISOString().split("T")[0]}`,
				`---`,
				`# ${apiTitle}\n\n${markdownBody}`,
			].join("\n");

			const safeFileName = apiTitle.replace(/[\\/:*?"<>|]/g, "-");
			const filePath = `${answerFolder}/${safeFileName}.md`;

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

		new Setting(containerEl).setName("根目录名称").addText((t) =>
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
