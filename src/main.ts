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
	userId: string;
	downloadFolder: string;
	cookie: string;
}

const DEFAULT_SETTINGS: ZhihuSettings = {
	userId: "",
	downloadFolder: "Zhihu_Imports",
	cookie: "",
};

export default class ZhihuLoaderPlugin extends Plugin {
	settings: ZhihuSettings;

	async onload() {
		await this.loadSettings();
		this.addRibbonIcon("link", "知乎终极导入", () =>
			this.showImportModal(),
		);
		this.addSettingTab(new ZhihuSettingTab(this.app, this));
	}

	showImportModal() {
		const modal = new ImportModal(this.app, async (url) => {
			if (url) await this.fetchZhihuAnswer(url);
		});
		modal.open();
	}

	async fetchZhihuAnswer(rawInput: string) {
		// 1. 提取 URL
		const urlMatch = rawInput.match(
			/https?:\/\/www\.zhihu\.com\/question\/\d+\/answer\/\d+/,
		);
		if (!urlMatch) {
			new Notice("❌ 链接识别失败");
			return;
		}
		const cleanUrl = urlMatch[0];
		const answerId = cleanUrl.match(/answer\/(\d+)/)?.[1] || "unknown";

		try {
			new Notice("🚀 正在深度抓取元数据与原图...");

			// 2. 获取 API 数据（包含所有社交字段）
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

			// 3. 准备目录
			const baseFolder = this.settings.downloadFolder;
			const assetFolder = `${baseFolder}/attachments`;
			const vault = this.app.vault;
			if (!(await vault.adapter.exists(baseFolder)))
				await vault.createFolder(baseFolder);
			if (!(await vault.adapter.exists(assetFolder)))
				await vault.createFolder(assetFolder);

			// 4. 图片高清无水印处理
			const parser = new DOMParser();
			const doc = parser.parseFromString(data.content, "text/html");
			const imgs = Array.from(doc.querySelectorAll("img"));
			const processedImages = new Set<string>();
			let imageIndex = 0;

			for (const img of imgs) {
				let rawSrc =
					img.getAttribute("data-actualsrc") ||
					img.getAttribute("data-original") ||
					img.getAttribute("src");
				if (
					!rawSrc ||
					rawSrc.includes("data:image/svg+xml") ||
					rawSrc.includes("equation")
				) {
					img.remove();
					continue;
				}

				// --- 🔥 彻底去水印逻辑 ---
				// 第一步：截断问号后面的所有参数（彻底干掉 ?source=...）
				let hdSrc = rawSrc.split("?")[0];
				// 第二步：正则匹配并粉碎所有尺寸后缀，还原为原始扩展名
				hdSrc = hdSrc.replace(
					/_[a-z0-9]+(\.(jpg|png|webp|jpeg|gif))/gi,
					"$1",
				);

				const imageId = hdSrc.split("/").pop() || hdSrc;

				if (processedImages.has(imageId)) {
					// 如果重复，重指向已有的本地文件索引
					const existingIdx =
						Array.from(processedImages).indexOf(imageId);
					const ext = hdSrc.split(".").pop() || "jpg";
					img.setAttribute(
						"src",
						`zhihu_${answerId}_${existingIdx}.${ext}`,
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

					if (!(await vault.adapter.exists(imgPath))) {
						await vault.createBinary(imgPath, imgRes.arrayBuffer);
					}
					img.setAttribute("src", imgName);
					processedImages.add(imageId);
					imageIndex++;
				} catch (e) {
					console.error("高清下载失败:", hdSrc);
				}
			}

			// 5. 转换 Markdown 并清理
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

			// --- 6. 找回所有细节元数据 ---
			const fileContent = [
				`---`,
				`标题: "${apiTitle.replace(/"/g, '\\"')}"`,
				`url: ${cleanUrl}`,
				`作者: ${data.author.name}`,
				`点赞数: ${data.voteup_count}`,
				`评论数: ${data.comment_count}`,
				`感谢数: ${data.thanks_count}`,
				`回答日期: ${new Date(data.created_time * 1000).toISOString().split("T")[0]}`,
				`最后更新: ${new Date(data.updated_time * 1000).toISOString().split("T")[0]}`,
				`导入日期: ${new Date().toISOString().split("T")[0]}`,
				`---`,
				`# ${apiTitle}`,
				``,
				`${markdownBody}`,
			].join("\n");

			const safeFileName = apiTitle.replace(/[\\/:*?"<>|]/g, "-");
			const filePath = `${baseFolder}/${safeFileName}.md`;

			const existingFile = vault.getAbstractFileByPath(filePath);
			if (existingFile instanceof TFile) {
				await vault.modify(existingFile, fileContent);
			} else {
				await vault.create(filePath, fileContent);
			}

			new Notice(`✅ 细节已全部找回！共处理 ${imageIndex} 张图`);
		} catch (error) {
			console.error(error);
			new Notice("❌ 抓取失败");
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
}

// Modal 和 SettingTab 保持不变
class ImportModal extends Modal {
	url: string = "";
	onSubmit: (url: string) => void;
	constructor(app: App, onSubmit: (url: string) => void) {
		super(app);
		this.onSubmit = onSubmit;
	}
	onOpen() {
		const { contentEl } = this;
		contentEl.createEl("h2", { text: "导入高清知乎" });
		new Setting(contentEl)
			.setName("链接")
			.addText((text) => text.onChange((v) => (this.url = v)));
		new Setting(contentEl).addButton((b) =>
			b
				.setButtonText("导入")
				.setCta()
				.onClick(() => {
					this.close();
					this.onSubmit(this.url);
				}),
		);
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
