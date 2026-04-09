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

		this.addRibbonIcon("refresh-cw", "一键同步我的所有回答", () =>
			this.syncAllMyAnswers(),
		);

		this.addRibbonIcon("link", "导入单个回答", () =>
			this.showImportModal(),
		);

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

		this.addCommand({
			id: "fetch-zhihu-goods-recommendation-v2",
			name: "获取今日好物推荐问题（新版含详细信息）",
			callback: () => this.fetchGoodsRecommendQuestionsV2(),
		});

		this.addSettingTab(new ZhihuSettingTab(this.app, this));
	}

	async syncAllMyAnswers() {
		const userId = this.settings.zhihuId;
		if (!userId) {
			new Notice("❌ 报错：请先设置用户 ID");
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
							new Notice("✨ 内容已是最新。");
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

			if (this.settings.enableRecommendSync)
				await this.fetchCreatorRecommendQuestions();
			if (this.settings.enableGoodsSync)
				await this.fetchGoodsRecommendQuestionsV2();
		} catch (e) {
			new Notice("❌ 同步中断！请检查 Cookie");
		}
	}

	/**
	 * 【2.0.2 修复】好物推荐抓取 - 修正 Token 映射链接逻辑
	 */
	async fetchGoodsRecommendQuestions() {
		if (!this.settings.cookie) {
			new Notice("⚠️ 请先设置知乎 Cookie");
			return;
		}

		try {
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
				new Notice("⚠️ 好物列表为空");
				return;
			}

			const vault = this.app.vault;
			const base = this.settings.downloadFolder;
			const goodsPath = `${base}/Goods`;

			if (!(await vault.adapter.exists(base)))
				await vault.createFolder(base);
			if (!(await vault.adapter.exists(goodsPath)))
				await vault.createFolder(goodsPath);

			let md = `## 知乎好物推荐列表 (${new Date().toLocaleDateString()})\n\n`;
			md +=
				"| 问题标题 | 回答数 | 浏览量 | 链接 |\n| :--- | :--- | :--- | :--- |\n";

			items.forEach((item: any) => {
				const questionId =
					item.token || (item.question && item.question.id);
				if (!questionId || !item.title) return;

				const title = item.title.replace(/\|/g, "\\|");
				const link = `https://www.zhihu.com/question/${questionId}`;
				const answers = item.answer_count || 0;
				const views = item.visit_count || "N/A";

				md += `| ${title} | ${answers} | ${views} | [直达问题](${link}) |\n`;
			});

			const fileName = `${goodsPath}/好物推荐_${new Date().toISOString().split("T")[0]}.md`;
			const file = vault.getAbstractFileByPath(fileName);

			if (file instanceof TFile) await vault.modify(file, md);
			else await vault.create(fileName, md);

			new Notice("✅ 好物清单链接已修正，同步成功");
		} catch (e) {
			console.error("Goods Sync Error:", e);
			new Notice("❌ 好物推荐抓取失败");
		}
	}

	/**
	 * 【2.0.3 新增】好物推荐抓取 v2 - 使用新 API 端点，获取完整问题信息
	 * 新端点: /api/v4/creators/question_route/author_related/goods
	 * 新增字段: answer_count, visit_count, follower_count, created(问题创建时间)
	 * 链接直接使用 API 返回的 question.url
	 */
	async fetchGoodsRecommendQuestionsV2() {
		if (!this.settings.cookie) {
			new Notice("⚠️ 请先设置知乎 Cookie");
			return;
		}

		try {
			const url =
				"https://www.zhihu.com/api/v4/creators/question_route/author_related/goods" +
				"?mcn=goods" +
				"&include=data%5B*%5D.label%2Creason_info%2Cquestion.answer_count%2Cfollower_count%2Cdetail%2Cauthor%2Ccreated" +
				"&limit=20&offset=0&page_source=web_author_recommend";

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
				new Notice("⚠️ 好物列表为空");
				return;
			}

			const vault = this.app.vault;
			const base = this.settings.downloadFolder;
			const goodsPath = `${base}/Goods`;

			if (!(await vault.adapter.exists(base)))
				await vault.createFolder(base);
			if (!(await vault.adapter.exists(goodsPath)))
				await vault.createFolder(goodsPath);

			let md = `## 知乎好物推荐列表 (${new Date().toLocaleDateString()})\n`;
			md += `生成时间: ${new Date().toLocaleString()}\n\n`;
			md +=
				"| 问题标题 | 回答数 | 浏览量 | 关注数 | 问题创建时间 | 链接 |\n";
			md += "| :--- | :---: | :---: | :---: | :---: | :--- |\n";

			items.forEach((item: any) => {
				const q = item.question;
				if (!q || !q.title) return;

				const title = q.title.replace(/\|/g, "\\|");

				// 直接使用 API 返回的完整 URL，无需手动拼接
				const link = q.url || `https://www.zhihu.com/question/${q.id}`;

				const answers = q.answer_count ?? 0;
				const views = q.visit_count ?? "N/A";
				const followers = q.follower_count ?? 0;

				// 将 Unix 时间戳（秒）解析为可读日期
				const createdDate = q.created
					? new Date(q.created * 1000).toLocaleDateString("zh-CN", {
							year: "numeric",
							month: "2-digit",
							day: "2-digit",
						})
					: "未知";

				md += `| ${title} | ${answers} | ${views} | ${followers} | ${createdDate} | [直达问题](${link}) |\n`;
			});

			const fileName = `${goodsPath}/好物推荐_${new Date().toISOString().split("T")[0]}.md`;
			const file = vault.getAbstractFileByPath(fileName);

			if (file instanceof TFile) await vault.modify(file, md);
			else await vault.create(fileName, md);

			new Notice("✅ 好物推荐（新版）同步成功");
		} catch (e) {
			console.error("Goods Sync V2 Error:", e);
			new Notice("❌ 好物推荐抓取失败");
		}
	}

	/**
	 * 创作者推荐抓取 - 2026/4/2 更新补全推荐理由与提问者
	 */
	async fetchCreatorRecommendQuestions() {
		if (!this.settings.cookie) {
			new Notice("⚠️ 请先设置知乎 Cookie");
			return;
		}
		try {
			const res = await requestUrl({
				url: "https://www.zhihu.com/api/v4/creators/question_route/author_related/recommend?limit=20&offset=0&page_source=web_author_recommend",
				method: "GET",
				headers: {
					Cookie: this.settings.cookie,
					"User-Agent":
						"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
				},
			});
			const items = res.json.data;
			if (!items || items.length === 0) {
				new Notice("⚠️ 创作者推荐列表为空");
				return;
			}

			const vault = this.app.vault;
			const baseFolder = this.settings.downloadFolder;
			const recommendFolder = `${baseFolder}/recommend`;

			// 确保文件夹存在
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

				// 1. 获取动态推荐理由 (item.reason 是知乎 API 返回的个性化理由)
				const reason = item.reason || "系统推荐";

				// 2. 获取提问者名称 (q.author 可能存在于嵌套对象中)
				const authorName = q.author?.name || "匿名用户";

				const safeTitle = q.title.replace(/\|/g, "\\|");
				const answerCount = q.answer_count || 0;
				const link = `https://www.zhihu.com/question/${q.id}`;

				tableContent += `| ${safeTitle} | ${reason} | ${authorName} | ${answerCount} | [查看问题](${link}) |\n`;
			}

			const filePath = `${recommendFolder}/创作者推荐_${new Date().toISOString().split("T")[0]}.md`;
			const existingFile = vault.getAbstractFileByPath(filePath);

			if (existingFile instanceof TFile) {
				await vault.modify(existingFile, tableContent);
			} else {
				await vault.create(filePath, tableContent);
			}

			new Notice(`✅ 推荐获取成功！已保存至 ${filePath}`);

			const finalFile = vault.getAbstractFileByPath(filePath);
			if (finalFile instanceof TFile)
				this.app.workspace.getLeaf().openFile(finalFile);
		} catch (e) {
			console.error(e);
			new Notice("❌ 获取推荐失败，请检查网络或 Cookie");
		}
	}

	/**
	 * 回答抓取核心逻辑 (带图片本地化)
	 * v2.0.4: 修复统计数据 undefined 问题，增强健壮性
	 */
	async fetchZhihuAnswer(
		cleanUrl: string,
	): Promise<"SUCCESS" | "SKIPPED" | "FAILED"> {
		const answerId = cleanUrl.match(/answer\/(\d+)/)?.[1];
		if (!answerId) return "FAILED";

		let voteupCount = 0,
			commentCount = 0,
			collectCount = 0,
			readCount = 0;

		try {
			// ========== 第一阶段：获取基本信息（不包含 voteup_count 等统计字段） ==========
			const infoRes = await requestUrl({
				url: `https://www.zhihu.com/api/v4/answers/${answerId}?include=question,author,created_time,updated_time,question.topics`,
				method: "GET",
				headers: {
					"User-Agent":
						"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
					Cookie: this.settings.cookie,
				},
			});
			const info = infoRes.json;

			// ========== 第二阶段：获取统计数据 ==========
			// 策略：优先使用 creations/v2/all（返回结构化字段），失败则降级到 link_card_infos（从 desc 解析）
			let statsFromCreations = false;
			
			// 方案A：尝试 creations/v2/all API（需要正确设置时间范围）
			try {
				const authorId = info.author?.id || info.author?.url_token;
				
				if (authorId) {
					// 估算回答的创建时间范围：往前推5年，足够覆盖绝大多数回答
					const now = Math.floor(Date.now() / 1000);
					const fiveYearsAgo = now - 5 * 365 * 24 * 60 * 60;
					
					// 使用更大的 limit，并尝试不同的 offset
					for (let attempt = 0; attempt < 3; attempt++) {
						const offset = attempt * 500;
						const creationsRes = await requestUrl({
							url: `https://www.zhihu.com/api/v4/creators/creations/v2/all?start=${now}&end=${fiveYearsAgo}&limit=500&offset=${offset}&need_co_creation=1&sort_type=created`,
							method: "GET",
							headers: {
								"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
								Cookie: this.settings.cookie,
							},
						});
						const creationsData = creationsRes.json;
						const dataList = creationsData.data || [];
						
						console.log(`[zhihu-loader] creations/v2/all: 获取到 ${dataList.length} 条数据`);
						
						// 正确的数据结构：统计字段在 reaction 对象里
						// { type: "answer", data: { id: "xxx" }, reaction: { vote_up_count, comment_count, ... } }
						if (dataList.length > 0) {
							// 检查是否是正确的数据结构（有 reaction 字段）
							const hasReaction = dataList.some((item: any) => item.reaction?.vote_up_count !== undefined);
							if (hasReaction) {
								const answerData = dataList.find(
									(item: any) => item.type === "answer" && String(item.data?.id) === String(answerId)
								);
								if (answerData) {
									voteupCount = answerData.reaction?.vote_up_count || 0;
									commentCount = answerData.reaction?.comment_count || 0;
									collectCount = answerData.reaction?.collect_count || 0;
									readCount = answerData.reaction?.read_count || 0;
									statsFromCreations = true;
									console.log(`[zhihu-loader] ✓ 从creations获取: voteup=${voteupCount}, comment=${commentCount}, collect=${collectCount}, read=${readCount}`);
									break;
								}
							} else {
								// creations/v2/all 没有统计字段，说明API结构变了
								console.log(`[zhihu-loader] creations/v2/all 无reaction字段，跳过`);
								break;
							}
						}
					}
				}
			} catch (e) {
				console.warn(`[zhihu-loader] creations/v2/all 请求失败:`, e);
			}

			// 方案B：降级到 link_card_infos API（从 extra_info.desc 解析）
			if (!statsFromCreations) {
				try {
					const answerUrl = encodeURIComponent(`https://www.zhihu.com/question/${info.question?.id}/answer/${answerId}`);
					const cardRes = await requestUrl({
						url: `https://www.zhihu.com/api/v4/editor/link_card_infos?scene=pcweb&urls=${answerUrl}`,
						method: "GET",
						headers: {
							"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
							Cookie: this.settings.cookie,
						},
					});
					const cardData = cardRes.json;
					
				// 获取第一个 URL 的 extra_info（cardData 是对象，键是 URL）
				const firstUrl = Object.keys(cardData)[0];
				const cardInfo = firstUrl ? cardData[firstUrl] : null;
				
				if (cardInfo?.extra_info) {
					const extraInfo = JSON.parse(cardInfo.extra_info);
					const desc = (extraInfo.desc || "").replace(/<[^>]+>/g, "").trim();
					console.log(`[zhihu-loader] link_card_infos: ${desc}`);
					
					// 解析格式："222 赞同 · 81 评论"
					const voteupMatch = desc.match(/(\d+)\s*赞同/);
					const commentMatch = desc.match(/(\d+)\s*评论/);
					if (voteupMatch) voteupCount = parseInt(voteupMatch[1]) || 0;
					if (commentMatch) commentCount = parseInt(commentMatch[1]) || 0;
				}
				} catch (e) {
					console.warn(`[zhihu-loader] link_card_infos 请求失败:`, e);
				}
			}

			// 第三步：获取回答正文内容
			const contentRes = await requestUrl({
				url: `https://www.zhihu.com/api/v4/answers/${answerId}?include=content`,
				method: "GET",
				headers: {
					"User-Agent":
						"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
					Cookie: this.settings.cookie,
				},
			});
			const contentData = contentRes.json;

			const apiTitle = info.question.title;
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
			if (stats && stats.mtime >= info.updated_time * 1000)
				return "SKIPPED";

			const parser = new DOMParser();
			const doc = parser.parseFromString(
				contentData.content,
				"text/html",
			);
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
				} catch (e) {
					console.warn(`⚠️ 图片下载失败: ${hd}`, e);
				}
			}

			const turndown = new TurndownService({
				headingStyle: "atx",
				bulletListMarker: "-",
			});
			turndown.addRule("zhihu-img", {
				filter: "img",
				replacement: (content, node: any) => {
					const s = node.getAttribute("src");
					// 只处理本地化后的文件名（不含协议头），跳过 data URI 和 http 链接
					if (!s || s.startsWith("http") || s.startsWith("data:"))
						return "";
					return `![[${s}]]`;
				},
			});
			const body = turndown.turndown(doc.body.innerHTML);
			const topics =
				info.question.topics
					?.map((t: any) => `'[[${t.name}]]'`)
					.join(", ") || "";

			const content = [
				`---`,
				`标题: "${apiTitle.replace(/"/g, '\\"')}"`,
				`url: ${cleanUrl}`,
				`话题: [${topics}]`,
				`点赞数: ${voteupCount}`,
				`评论数: ${commentCount}`,
				`收藏数: ${collectCount}`,
				`阅读数: ${readCount}`,
				`作者: ${info.author?.name ?? ""}`,
				`日期: ${new Date(info.created_time * 1000).toISOString().split("T")[0]}`,
				`更新: ${new Date(info.updated_time * 1000).toISOString().split("T")[0]}`,
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
		new Setting(containerEl)
			.setName("知乎 Cookie")
			.setDesc("用于获取推荐内容，Cookie 信息将隐藏显示")
			.addText((t) =>
				t
					.setPlaceholder("输入你的知乎 Cookie")
					.setValue(this.plugin.settings.cookie)
					.onChange(async (v) => {
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
