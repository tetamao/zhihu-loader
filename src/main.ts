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
import { ZhihuLoginModal } from "./components/ZhihuLoginModal";

interface ZhihuSettings {
	downloadFolder: string;
	cookie: string;
	zhihuId: string;
	enableRecommendSync: boolean;
	enableGoodsSync: boolean;
	userName?: string;
	userAvatar?: string;
	cookieValidUntil?: number;
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
	settingTab?: ZhihuSettingTab;
	// creations 缓存：key=answerId, value=统计数据 + 元信息
	creationsCache: Map<string, {
		voteupCount: number;
		commentCount: number;
		collectCount: number;
		readCount: number;
		updatedTime: number;   // 知乎最后更新时间（Unix 秒）
		questionId: string;    // 所属问题 ID
		title: string;         // 问题标题（用于文件 frontmatter）
	}> = new Map();

	/**
	 * 【v2.0.6 恢复】构建 creations/v2/all 缓存
	 * 用于批量同步时 O(1) 获取统计数据
	 */
	async buildCreationsCache(): Promise<void> {
		new Notice("📦 正在预拉取 creations 缓存...");
		let offset = 0;
		const LIMIT = 20;
		let totalFetched = 0;
		let maxRetries = 5;
		let retryCount = 0;

		while (retryCount < maxRetries) {
			try {
				const res = await requestUrl({
					url: `https://www.zhihu.com/api/v4/creators/creations/v2/all?start=0&end=0&limit=${LIMIT}&offset=${offset}&need_co_creation=0&sort_type=updated`,
					method: "GET",
					headers: {
						"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
						Cookie: this.settings.cookie,
					},
				});

				const data = res.json;
				const items = data.data || [];
				const totals = data.paging?.totals || 0;

				for (const item of items) {
					// 只缓存 answer 类型
					if (item.type !== "answer") continue;
					const id = String(item.data?.id);
					if (!id) continue;

					this.creationsCache.set(id, {
						voteupCount: item.reaction?.vote_up_count ?? 0,
						commentCount: item.reaction?.comment_count ?? 0,
						collectCount: item.reaction?.collect_count ?? 0,
						readCount: item.reaction?.read_count ?? 0,
						updatedTime: item.data?.updated_time ?? 0,
						questionId: String(item.data?.question?.id ?? ""),
						// 兼容两种 API 数据结构：creations/v2/all 用 item.data.question.title，members/answers 用 item.question.title
						title: item.data?.question?.title || item.question?.title || "",
					});
				}

				totalFetched += items.length;
				console.log(`[zhihu-loader] creations 缓存进度: ${totalFetched}/${totals}`);

				// 判断是否结束
				if (totalFetched >= totals || items.length === 0) break;

				offset += LIMIT;
				retryCount = 0; // 重置重试计数
				await new Promise((r) => setTimeout(r, 500));
			} catch (e: any) {
				retryCount++;
				if (e?.status === 403) {
					console.warn(`[zhihu-loader] creations 缓存 403，重试 (${retryCount}/${maxRetries})...`);
					await new Promise((r) => setTimeout(r, 3000 * retryCount));
				} else {
					console.error("[zhihu-loader] creations 缓存拉取失败:", e);
					break;
				}
			}
		}

		console.log(`[zhihu-loader] creations 缓存构建完成，共 ${this.creationsCache.size} 条`);
		new Notice(`📦 缓存构建完成 (${this.creationsCache.size} 条)`);
	}

	/**
	 * 打开知乎扫码登录弹窗，登录成功后自动保存 Cookie 和用户信息
	 */
	openZhihuLogin() {
		const modal = new ZhihuLoginModal(
			this.app,
			async (cookie: string, userName?: string, peopleId?: string, avatarUrl?: string) => {
				// 保存 Cookie
				this.settings.cookie = cookie;
				this.settings.userName = userName || "";
				if (avatarUrl) {
					this.settings.userAvatar = avatarUrl;
				}
				// 粗略估计有效期（知乎 Cookie 通常约 30 天）
				this.settings.cookieValidUntil = Date.now() + 30 * 24 * 60 * 60 * 1000;

				// 如果扫码已获取 peopleId，直接使用（url_token，用户端展示格式）
				if (peopleId) {
					this.settings.zhihuId = peopleId;
				}

				// 如果没有获取到 peopleId，尝试从 API 获取
				if (!peopleId) {
					try {
						const meRes = await requestUrl({
							url: "https://www.zhihu.com/api/v4/me",
							method: "GET",
							headers: {
								"User-Agent": "Mozilla/5.0",
								Cookie: cookie,
							},
						});
						const meData = meRes.json;
						if (meData?.url_token) {
							// 优先使用 url_token（用户端展示格式）
							this.settings.zhihuId = meData.url_token;
						} else if (meData?.id) {
							// 兜底使用数字 ID
							this.settings.zhihuId = String(meData.id);
						}
						// 保存用户名和头像（优先用 API 返回的，质量更高）
						if (meData?.name && !this.settings.userName) {
							this.settings.userName = meData.name;
						}
						if (meData?.avatar_url) {
							this.settings.userAvatar = meData.avatar_url;
						}
					} catch (_e) {
						// 获取 ID 失败不影响登录成功
					}
				}

				await this.saveSettings();
				new Notice(`✅ 知乎登录成功！${userName ? `欢迎，${userName}` : ""}`);

				// 刷新设置页
				this.settingTab?.display();
			},
			() => {
				// 取消登录
				new Notice("ℹ️ 登录已取消");
			},
		);
		modal.open();
	}

	/**
	 * 注销知乎登录，清除 Cookie 和用户信息
	 */
	async logoutZhihu() {
		this.settings.cookie = "";
		this.settings.userName = "";
		this.settings.userAvatar = "";
		this.settings.cookieValidUntil = undefined;
		this.settings.zhihuId = "";
		// 清理 creations 缓存
		this.creationsCache.clear();
		// 清理 Electron session 中的 zhihu cookie，避免残留登录状态
		this.clearElectronZhihuCookies();
		await this.saveSettings();
		new Notice("✅ 已注销知乎登录");
	}

	/**
	 * 清除 Electron defaultSession 中 zhihu 相关的 Cookie
	 * 这样重新打开登录窗口时不会残留旧登录状态
	 */
	private async clearElectronZhihuCookies() {
		try {
			const { remote } = require("electron");
			const session = remote.session;
			const domains = ["zhihu.com", ".zhihu.com", "www.zhihu.com", "link.zhihu.com"];
			for (const domain of domains) {
				try {
					const cookies = await session.cookies.get({ domain });
					for (const cookie of cookies) {
						await session.cookies.remove(`https://${cookie.domain || domain}`, cookie.name);
					}
				} catch (_e) {
					// ignore
				}
			}
			console.log("[zhihu-loader] 已清除 Electron session 中的 zhihu cookie");
		} catch (_e) {
			// Electron 不可用时忽略
		}
	}

	/**
	 * 判断当前是否已登录（Cookie 非空）
	 */
	isZhihuLoggedIn(): boolean {
		return !!(this.settings.cookie && this.settings.cookie.includes("z_c0"));
	}

	/**
	 * [阶段二最小化测试] 测试 Electron API 可用性 + 读取 zhihu.com Cookie
	 * 测试步骤：
	 * 1. 检查 require('electron') 是否可用
	 * 2. 尝试读取 session.cookies（zhihu.com 域名）
	 * 3. 检查 z_c0 cookie 是否存在
	 * 4. 验证 cookie 有效性（调用知乎 API）
	 */
	async testElectronCookie(): Promise<void> {
		new Notice("🔬 开始 Electron API 测试...");

		// ===== Step 1: 检查 Electron remote =====
		let electronAvailable = false;
		let remoteModule: any = null;
		try {
			// eslint-disable-next-line @typescript-eslint/no-var-requires
			remoteModule = require("electron").remote;
			electronAvailable = !!remoteModule;
			console.log("[CookieTest] ✅ Electron remote 可用:", electronAvailable);
		} catch (e: any) {
			console.error("[CookieTest] ❌ Electron remote 不可用:", e?.message || e);
			new Notice("❌ Electron API 不可用（非桌面环境？）");
			return;
		}

		// ===== Step 2: 读取 zhihu.com cookies =====
		let cookieStore: any = null;
		let zhihuCookies: any[] = [];
		try {
			cookieStore = remoteModule.require("electron").session?.defaultSession?.cookies ||
				remoteModule.session?.defaultSession?.cookies;
			if (!cookieStore) {
				// 尝试另一种路径
				const { session } = remoteModule.require("electron");
				cookieStore = session.defaultSession?.cookies;
			}
			console.log("[CookieTest] cookieStore 对象:", cookieStore);

			if (cookieStore) {
				zhihuCookies = await cookieStore.get({ domain: "zhihu.com" });
				console.log(`[CookieTest] zhihu.com 共 ${zhihuCookies.length} 个 Cookie`);
				for (const c of zhihuCookies) {
					console.log(`  - ${c.name}: ${c.value.substring(0, 20)}... (httpOnly=${c.httpOnly}, secure=${c.secure})`);
				}
			}
		} catch (e: any) {
			console.error("[CookieTest] ❌ 读取 Cookie 失败:", e?.message || e);
			new Notice("❌ 读取 Cookie 失败: " + (e?.message || "未知错误"));
		}

		// ===== Step 3: 检查 z_c0 =====
		const z_c0 = zhihuCookies.find((c) => c.name === "z_c0");
		if (z_c0) {
			console.log("[CookieTest] ✅ 找到 z_c0 Cookie，长度:", z_c0.value.length);
			new Notice("✅ 已登录！z_c0 存在");
		} else {
			console.warn("[CookieTest] ⚠️ 未找到 z_c0 Cookie，可能未登录");
			new Notice("⚠️ 未找到 z_c0，请先在知乎网页登录");
		}

		// ===== Step 4: 组装完整 Cookie 字符串 =====
		const cookieStr = zhihuCookies.map((c) => `${c.name}=${c.value}`).join("; ");
		console.log("[CookieTest] 完整 Cookie 字符串:", cookieStr.substring(0, 100) + "...");

		// ===== Step 5: 验证 Cookie 有效性 =====
		if (z_c0) {
			try {
				const userId = this.settings.zhihuId;
				const testUrl = userId
					? `https://www.zhihu.com/api/v4/members/${userId}/answers?limit=1`
					: "https://www.zhihu.com/api/v4/people/me?include=followee_count,answer_count";

				const res = await requestUrl({
					url: testUrl,
					method: "GET",
					headers: {
						"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
						Cookie: cookieStr,
					},
				});

				if (res.status === 200) {
					console.log("[CookieTest] ✅ Cookie 验证通过！API 返回 200");
					new Notice("✅ Cookie 有效！API 验证成功");
					console.log("[CookieTest] 响应预览:", JSON.stringify(res.json)?.substring(0, 200));
				} else {
					console.warn(`[CookieTest] ⚠️ API 返回 ${res.status}，Cookie 可能已过期`);
					new Notice(`⚠️ API 返回 ${res.status}，Cookie 可能过期`);
				}
			} catch (e: any) {
				console.error("[CookieTest] ❌ Cookie 验证失败:", e?.message || e);
				new Notice("❌ Cookie 验证失败");
			}
		}

		// ===== 汇总 =====
		console.log("[CookieTest] ===== 测试汇总 =====");
		console.log("1. Electron remote:", electronAvailable ? "✅" : "❌");
		console.log("2. zhihu.com Cookie 数量:", zhihuCookies.length);
		console.log("3. z_c0 存在:", z_c0 ? "✅" : "❌");
		new Notice("🔬 测试完成，请查看 Obsidian Console 查看详细日志");
	}

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

		// [TEST] 阶段二最小化测试：Electron API 可用性 + zhihu.com Cookie 检测
		this.addCommand({
			id: "test-electron-cookie",
			name: "[测试] 检测知乎登录状态（Electron）",
			callback: () => this.testElectronCookie(),
		});

		this.addSettingTab(new ZhihuSettingTab(this.app, this));
	}

	async syncAllMyAnswers() {
		const userId = this.settings.zhihuId;
		if (!userId) {
			new Notice("❌ 报错：请先设置用户 ID");
			return;
		}

		new Notice("🔍 正在启动同步...");

		let totalSuccess = 0;
		let totalSkipped = 0;
		let totalFailed = 0;
		let cacheHit = 0;
		let cacheMiss = 0;

		try {
			// ===== 第零步：预拉取 creations 缓存 =====
			await this.buildCreationsCache();

			// ===== 第一步：从问答列表翻页获取所有回答ID =====
			const answerList: Array<{ id: string; questionId: string; updatedTime: number; title: string }> = [];
			let offset = 0;
			const PAGE_SIZE = 20;

			new Notice("📝 正在获取回答列表...");

			while (true) {
				try {
				const res = await requestUrl({
					url: `https://www.zhihu.com/api/v4/members/${userId}/answers?offset=${offset}&limit=${PAGE_SIZE}&sort_by=updated&include=question.title,created_time,updated_time`,
						method: "GET",
						headers: {
							"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
							Cookie: this.settings.cookie,
						},
					});
					const data = res.json;
					const items = data.data || [];

					if (items.length === 0) break;

				for (const item of items) {
					if (item.id && item.question?.id) {
						// 优先从 creationsCache 获取 title，fallback 到列表数据
						const cached = this.creationsCache.get(String(item.id));
						const title = cached?.title || item.question?.title || `未命名_${item.id}`;
						answerList.push({
							id: String(item.id),
							questionId: String(item.question.id),
							updatedTime: item.updated_time || 0,
							title,
						});
					}
				}

					console.log(`[zhihu-loader] 已获取 ${answerList.length} 条回答列表...`);

					if (data.paging?.is_end) break;
					offset += PAGE_SIZE;

					// 翻页间隔
					await new Promise((r) => setTimeout(r, 1000));
				} catch (e: any) {
					if (e?.status === 403) {
						console.warn(`[zhihu-loader] 列表翻页 403，等待5秒后重试...`);
						await new Promise((r) => setTimeout(r, 5000));
					} else {
						throw e;
					}
				}
			}

		console.log(`[zhihu-loader] 共获取 ${answerList.length} 条回答，开始同步...`);
		new Notice(`📝 共 ${answerList.length} 条回答，开始同步...`);

		// 确保目录存在（提前一次性创建）
		const vault = this.app.vault;
		const base = this.settings.downloadFolder;
		const answerDir = `${base}/answers`;
		const assetDir = `${base}/attachments`;
		if (!(await vault.adapter.exists(base))) await vault.createFolder(base);
		if (!(await vault.adapter.exists(answerDir))) await vault.createFolder(answerDir);
		if (!(await vault.adapter.exists(assetDir))) await vault.createFolder(assetDir);

		// ===== 第二步：遍历每个回答，先本地增量比对，再按需请求 =====
		for (const answer of answerList) {
			const answerId = answer.id;
			const questionId = answer.questionId;
			const answerUrl = `https://www.zhihu.com/question/${questionId}/answer/${answerId}`;
			// 优先用 creationsCache 的 title，fallback 到 answerList 阶段获取的 title
			const cachedEntry = this.creationsCache.get(answerId);
			const apiTitle = cachedEntry?.title || answer.title;

			// ===== 文件名用回答标题（sanitize 处理特殊字符）=====
			// 规则：问号全部保留，只替换文件系统非法字符和 Obsidian 特殊字符
			const safeTitle = apiTitle
				.replace(/[\\/:*?"<>|#\[\]]/g, "_")  // 替换非法字符为下划线（问号保留）
				.replace(/_+/g, "_")                  // 合并连续下划线
				.replace(/^_|_$/g, "")                 // 去除首尾下划线
				.substring(0, 120);                    // 截断

			// ===== 增量判断（请求前，基于标题命名的本地文件）=====
			const localPath = `${answerDir}/${safeTitle}.md`;
			const localStats = await vault.adapter.stat(localPath);
			// 用 creations 缓存中的 updatedTime，fallback 到列表中的 updatedTime
			const remoteUpdatedTime = cachedEntry?.updatedTime ?? answer.updatedTime ?? 0;

			if (localStats && remoteUpdatedTime && localStats.mtime >= remoteUpdatedTime * 1000) {
				totalSkipped++;
				console.log(`[zhihu-loader] 跳过（本地已是最新）: ${safeTitle}`);
				continue;  // ← 完全不发任何 API 请求
			}

			// ===== 需要同步：从缓存获取统计数据 =====
			let voteupCount = 0;
			let commentCount = 0;
			let collectCount = 0;
			let readCount = 0;

			if (cachedEntry) {
				voteupCount = cachedEntry.voteupCount;
				commentCount = cachedEntry.commentCount;
				collectCount = cachedEntry.collectCount;
				readCount = cachedEntry.readCount;
				cacheHit++;
				console.log(`[zhihu-loader] 缓存命中: ${safeTitle} - ${voteupCount} 赞`);
			} else {
				cacheMiss++;
				console.log(`[zhihu-loader] 缓存未命中，将请求 API: ${safeTitle}`);
			}

			// ===== 发起网络请求：并行获取基本信息 + 正文 =====
			let retryCount = 0;
			const maxRetries = 3;
			let success = false;

			while (retryCount < maxRetries && !success) {
				try {
					const [infoRes, contentRes] = await Promise.all([
						requestUrl({
							url: `https://www.zhihu.com/api/v4/answers/${answerId}?include=question,author,created_time,updated_time,question.topics`,
							method: "GET",
							headers: {
								"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
								Cookie: this.settings.cookie,
							},
						}),
						requestUrl({
							url: `https://www.zhihu.com/api/v4/answers/${answerId}?include=content`,
							method: "GET",
							headers: {
								"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
								Cookie: this.settings.cookie,
							},
						}),
					]);

					const infoText = infoRes.text;
					const contentText = contentRes.text;
					if (!infoText || !contentText) {
						console.error("[zhihu-loader] 空响应，answerId:", answerId);
						throw new Error("空响应");
					}
					let info: any, contentData: any;
					try { info = JSON.parse(infoText); } catch { throw new Error(`infoRes 非JSON: ${infoText.substring(0, 100)}`); }
					try { contentData = JSON.parse(contentText); } catch { throw new Error(`contentRes 非JSON: ${contentText.substring(0, 100)}`); }
					if (info.error) throw new Error(`回答已删除: ${info.error.message}`);

				const answerContent = contentData.content || "";
				// 优先使用已缓存的标题，API 返回的 title 作为兜底
				const finalTitle = apiTitle || info.question?.title || "无标题";

					// 缓存未命中时：用问题回答列表翻页获取统计数据
					if (!cachedEntry) {
						let found = false;
						for (let pageOffset = 0; pageOffset < 200 && !found; pageOffset += 20) {
							try {
								const listRes = await requestUrl({
									url: `https://www.zhihu.com/api/v4/questions/${questionId}/answers?include=data%5B*%5D.voteup_count,data%5B*%5D.comment_count,data%5B*%5D.thanks_count,data%5B*%5D.id&limit=20&offset=${pageOffset}&sort_by=created_time`,
									method: "GET",
									headers: {
										"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
										Cookie: this.settings.cookie,
									},
								});
								const listData = listRes.json;
								const match = listData.data?.find((a: any) => String(a.id) === answerId);
								if (match) {
									voteupCount = match.voteup_count ?? 0;
									commentCount = match.comment_count ?? 0;
									found = true;
									console.log(`[zhihu-loader] 翻页命中: ${answerId} - ${voteupCount} 赞`);
								}
								if (listData.paging?.is_end) break;
							} catch (e) {
								console.warn(`[zhihu-loader] 问题列表翻页失败:`, e);
								break;
							}
						}

						// 第三级：link_card_infos 兜底
						if (!found) {
							try {
								const cardUrl = encodeURIComponent(answerUrl);
								const cardRes = await requestUrl({
									url: `https://www.zhihu.com/api/v4/editor/link_card_infos?scene=pcweb&urls=${cardUrl}`,
									method: "GET",
									headers: {
										"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
										Cookie: this.settings.cookie,
									},
								});
								const cardText = cardRes.text;
								if (cardText) {
									const cardData = JSON.parse(cardText);
									const firstUrl = Object.keys(cardData)[0];
									const cardInfo = firstUrl ? cardData[firstUrl] : null;
									if (cardInfo?.extra_info) {
										const extraInfo = JSON.parse(cardInfo.extra_info);
										const desc = (extraInfo.desc || "").replace(/<[^>]+>/g, "").trim();
										const voteupMatch = desc.match(/(\d+)\s*赞同/);
										const commentMatch = desc.match(/(\d+)\s*评论/);
										if (voteupMatch) voteupCount = parseInt(voteupMatch[1]) || 0;
										if (commentMatch) commentCount = parseInt(commentMatch[1]) || 0;
										console.log(`[zhihu-loader] link_card_infos 兜底: ${desc}`);
									}
								}
							} catch (e) {
								console.warn(`[zhihu-loader] link_card_infos 获取失败:`, e);
							}
						}
					}

				// 处理正文和图片（文件名使用回答标题）
				const result = await this.processAndSaveAnswer({
					answerId,
					questionId,
					answerUrl,
					apiTitle: finalTitle,
						answerContent,
						voteupCount,
						commentCount,
						collectCount,
						readCount,
						info,
						path: localPath,
						assetDir,
					});

					if (result === "SUCCESS") totalSuccess++;
					else if (result === "SKIPPED") totalSkipped++;
					else totalFailed++;

					success = true;
					// 实际发出请求后，间隔 3s 避免限流
					await new Promise((resolve) => setTimeout(resolve, 3000));
				} catch (err: any) {
					retryCount++;
					if (err?.status === 403 && retryCount < maxRetries) {
						const delay = 5000 * retryCount;
						console.warn(`[zhihu-loader] ⚠️ 403限流，${delay}ms后重试(${retryCount}/${maxRetries})`);
						await new Promise((r) => setTimeout(r, delay));
					} else {
						console.error(`[zhihu-loader] 同步失败:`, err);
						totalFailed++;
						success = true;
					}
				}
			}

			}
		// 注意：间隔 3s 已在内部 while 循环结束后自然等待，跳过的条目不等待

			new Notice(`✅ 回答同步完成！新增: ${totalSuccess}，跳过: ${totalSkipped}，失败: ${totalFailed}（缓存命中: ${cacheHit}，未命中: ${cacheMiss}）`);

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
	 * 处理正文并保存回答文件（批量同步和单篇导入共用）
	 */
	async processAndSaveAnswer(params: {
		answerId: string;
		questionId: string;
		answerUrl: string;
		apiTitle: string;
		answerContent: string;
		voteupCount: number;
		commentCount: number;
		collectCount?: number;
		readCount?: number;
		info: any;
		path: string;
		assetDir: string;
	}): Promise<"SUCCESS" | "SKIPPED" | "FAILED"> {
		const { answerId, answerUrl, apiTitle, answerContent, voteupCount, commentCount, collectCount = 0, readCount = 0, info, path, assetDir } = params;

		try {
			const vault = this.app.vault;

			// 处理图片本地化
			const parser = new DOMParser();
			const doc = parser.parseFromString(answerContent, "text/html");
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
				let hd = (src.split("?")[0] ?? src)
					.replace(/_[a-z0-9]+(\.(jpg|png|webp|jpeg|gif))/gi, "$1");
				const id = hd.split("/").pop() || hd;
				if (processed.has(id)) continue;

				try {
					const res = await requestUrl({ url: hd, method: "GET" });
					const ext = hd.split(".").pop() || "jpg";
					const name = `zhihu_${answerId}_${idx}.${ext}`;
					await vault.createBinary(`${assetDir}/${name}`, res.arrayBuffer);
					img.setAttribute("src", name);
					processed.add(id);
					idx++;
				} catch (e) {
					console.warn(`⚠️ 图片下载失败: ${hd}`, e);
				}
			}

			// 转换为 Markdown
			const turndown = new TurndownService({
				headingStyle: "atx",
				bulletListMarker: "-",
			});
			turndown.addRule("zhihu-img", {
				filter: "img",
				replacement: (content, node: any) => {
					const s = node.getAttribute("src");
					if (!s || s.startsWith("http") || s.startsWith("data:"))
						return "";
					return `![[${s}]]`;
				},
			});
			const body = turndown.turndown(doc.body.innerHTML);
			const topics = (info.question?.topics || [])
				.map((t: any) => `'[[${t.name}]]'`)
				.join(", ") || "";

			const content = [
				`---`,
				`标题: "${apiTitle.replace(/"/g, '\\"')}"`,
				`url: ${answerUrl}`,
				`话题: [${topics}]`,
				`点赞数: ${voteupCount}`,
				`评论数: ${commentCount}`,
				`收藏数: ${collectCount}`,
				`阅读数: ${readCount}`,
				`作者: ${info.author?.name ?? ""}`,
				`日期: ${info.created_time ? new Date(info.created_time * 1000).toISOString().split("T")[0] : ""}`,
				`更新: ${info.updated_time ? new Date(info.updated_time * 1000).toISOString().split("T")[0] : ""}`,
				`---`,
				`# ${apiTitle}\n\n${body}`,
			].join("\n");

			const file = vault.getAbstractFileByPath(path);
			if (file instanceof TFile) await vault.modify(file, content);
			else await vault.create(path, content);

			return "SUCCESS";
		} catch (error) {
			console.error(`[zhihu-loader] 保存回答失败:`, error);
			return "FAILED";
		}
	}

	/**
	 * 单篇回答导入（用于"导入单个回答"功能）
	 * 使用 link_card_infos 获取统计数据
	 */
	async fetchZhihuAnswer(
		cleanUrl: string,
	): Promise<"SUCCESS" | "SKIPPED" | "FAILED"> {
		const answerId = cleanUrl.match(/answer\/(\d+)/)?.[1];
		if (!answerId) {
			new Notice("❌ 链接格式错误，请确认是知乎回答链接");
			return "FAILED";
		}

		new Notice("🔍 正在获取回答...");

		try {
			// 并行请求：基本信息 + 正文内容
			const [infoRes, contentRes] = await Promise.all([
				requestUrl({
					url: `https://www.zhihu.com/api/v4/answers/${answerId}?include=question,author,created_time,updated_time,question.topics`,
					method: "GET",
					headers: {
						"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
						Cookie: this.settings.cookie,
					},
				}),
				requestUrl({
					url: `https://www.zhihu.com/api/v4/answers/${answerId}?include=content`,
					method: "GET",
					headers: {
						"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
						Cookie: this.settings.cookie,
					},
				}),
			]);

			// 检查响应是否有效（防止验证码页面等非JSON响应）
			const infoText = infoRes.text;
			const contentText = contentRes.text;

			if (!infoText || !contentText) {
				new Notice("❌ 获取失败：空响应，请检查 Cookie");
				return "FAILED";
			}

			let info: any, contentData: any;
			try {
				info = JSON.parse(infoText);
			} catch {
				new Notice("❌ 获取失败：知乎返回非JSON响应（可能被风控）");
				console.error("[zhihu-loader] infoRes 非JSON:", infoText.substring(0, 200));
				return "FAILED";
			}
			try {
				contentData = JSON.parse(contentText);
			} catch {
				new Notice("❌ 获取失败：正文返回非JSON响应（可能被风控）");
				console.error("[zhihu-loader] contentRes 非JSON:", contentText.substring(0, 200));
				return "FAILED";
			}

			// 检查是否是错误响应
			if (info.error) {
				new Notice(`❌ 回答不存在或已被删除 (${info.error.message})`);
				return "FAILED";
			}

			const answerContent = contentData.content || "";
			const questionId = info.question?.id;
			const apiTitle = info.question?.title || "无标题";

			// ===== 统计数据：三级降级策略 =====
			let voteupCount = 0;
			let commentCount = 0;
			let collectCount = 0;
			let readCount = 0;

			// 第一级：查询缓存
			const cachedStats = this.creationsCache.get(answerId);
			if (cachedStats) {
				voteupCount = cachedStats.voteupCount;
				commentCount = cachedStats.commentCount;
				collectCount = cachedStats.collectCount;
				readCount = cachedStats.readCount;
				console.log(`[zhihu-loader] 单篇缓存命中: ${answerId} - ${voteupCount} 赞`);
			} else {
				// 第二级：问题回答列表翻页
				let found = false;
				for (let pageOffset = 0; pageOffset < 200 && !found; pageOffset += 20) {
					try {
						const listRes = await requestUrl({
							url: `https://www.zhihu.com/api/v4/questions/${questionId}/answers?include=data%5B*%5D.voteup_count,data%5B*%5D.comment_count,data%5B*%5D.thanks_count,data%5B*%5D.id&limit=20&offset=${pageOffset}&sort_by=created_time`,
							method: "GET",
							headers: {
								"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
								Cookie: this.settings.cookie,
							},
						});
						const listData = listRes.json;
						const match = listData.data?.find((a: any) => String(a.id) === answerId);
						if (match) {
							voteupCount = match.voteup_count ?? 0;
							commentCount = match.comment_count ?? 0;
							found = true;
							console.log(`[zhihu-loader] 单篇翻页命中: ${answerId} - ${voteupCount} 赞`);
						}
						if (listData.paging?.is_end) break;
					} catch (e) {
						console.warn(`[zhihu-loader] 问题列表翻页失败:`, e);
						break;
					}
				}

				// 第三级：link_card_infos 兜底
				if (!found) {
					try {
						const cardUrl = encodeURIComponent(cleanUrl);
						const cardRes = await requestUrl({
							url: `https://www.zhihu.com/api/v4/editor/link_card_infos?scene=pcweb&urls=${cardUrl}`,
							method: "GET",
							headers: {
								"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
								Cookie: this.settings.cookie,
							},
						});
						const cardText = cardRes.text;
						if (cardText) {
							const cardData = JSON.parse(cardText);
							const firstUrl = Object.keys(cardData)[0];
							const cardInfo = firstUrl ? cardData[firstUrl] : null;
							if (cardInfo?.extra_info) {
								const extraInfo = JSON.parse(cardInfo.extra_info);
								const desc = (extraInfo.desc || "").replace(/<[^>]+>/g, "").trim();
								const voteupMatch = desc.match(/(\d+)\s*赞同/);
								const commentMatch = desc.match(/(\d+)\s*评论/);
								if (voteupMatch) voteupCount = parseInt(voteupMatch[1]) || 0;
								if (commentMatch) commentCount = parseInt(commentMatch[1]) || 0;
								console.log(`[zhihu-loader] link_card_infos 兜底: ${desc}`);
							}
						}
					} catch (e) {
						console.warn(`[zhihu-loader] link_card_infos 获取失败:`, e);
					}
				}
			}

			// 增量判断
			const vault = this.app.vault;
			const base = this.settings.downloadFolder;
			const answerDir = `${base}/answers`;
			const assetDir = `${base}/attachments`;

			if (!(await vault.adapter.exists(base))) await vault.createFolder(base);
			if (!(await vault.adapter.exists(answerDir))) await vault.createFolder(answerDir);
			if (!(await vault.adapter.exists(assetDir))) await vault.createFolder(assetDir);

			// 文件名 sanitize（与批量同步规则保持一致）
			// 文件名 sanitize（与批量同步规则保持一致）
			const safeName = apiTitle
				.replace(/[\\/:*?"<>|#\[\]]/g, "_")  // 替换非法字符为下划线（问号保留）
				.replace(/_+/g, "_")                  // 合并连续下划线
				.replace(/^_|_$/g, "")                 // 去除首尾下划线
				.substring(0, 120);
			const path = `${answerDir}/${safeName}.md`;
			const stats = await vault.adapter.stat(path);

			if (stats && info.updated_time && stats.mtime >= info.updated_time * 1000) {
				return "SKIPPED";
			}

			return await this.processAndSaveAnswer({
				answerId,
				questionId: questionId || "",
				answerUrl: cleanUrl,
				apiTitle,
				answerContent,
				voteupCount,
				commentCount,
				collectCount,
				readCount,
				info,
				path,
				assetDir,
			});
		} catch (error) {
			console.error(`[zhihu-loader] 单篇导入失败:`, error);
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
		plugin.settingTab = this; // 保存引用用于刷新
	}
	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		// ========== 登录状态区域 ==========
		const isLoggedIn = this.plugin.isZhihuLoggedIn();

		if (isLoggedIn) {
			// 已登录状态 - 卡片式布局
			containerEl.createDiv({ text: "账号", cls: "setting-item-heading" });

			const cardDiv = containerEl.createDiv("zhihu-login-card zhihu-card-loggedin");
			cardDiv.style.cssText = "border-radius: 8px; padding: 16px; margin: 8px 0; background: linear-gradient(135deg, #f0fdf4 0%, #dcfce7 100%); border: 1px solid #86efac;";

			// 头部：头像 + 用户名
			const headerDiv = cardDiv.createDiv();
			headerDiv.style.cssText = "display: flex; align-items: center; gap: 12px; margin-bottom: 12px;";

			// 头像（增强兜底：SVG data URL 作为默认值，避免 onerror 闪烁）
			const defaultAvatar = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='48' height='48' viewBox='0 0 24 24' fill='%2322c55e'%3E%3Cpath d='M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z'/%3E%3C/svg%3E";
			const avatarImg = headerDiv.createEl("img");
			avatarImg.style.cssText = "width: 48px; height: 48px; border-radius: 50%; border: 2px solid #22c55e; object-fit: cover; flex-shrink: 0;";
			if (this.plugin.settings.userAvatar) {
				avatarImg.src = this.plugin.settings.userAvatar;
				avatarImg.alt = "头像";
				// 图片加载失败时使用 SVG 兜底
				avatarImg.onerror = () => {
					avatarImg.src = defaultAvatar;
				};
			} else {
				avatarImg.src = defaultAvatar;
				avatarImg.alt = "默认头像";
			}

			// 用户名 + 状态
			const userInfoDiv = headerDiv.createDiv();
			userInfoDiv.style.cssText = "flex: 1; min-width: 0;";

			const nameDiv = userInfoDiv.createDiv({
				text: this.plugin.settings.userName || "知乎用户",
			});
			nameDiv.style.cssText = "font-weight: 600; font-size: 16px; color: #166534; margin-bottom: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;";

			const statusBadge = userInfoDiv.createDiv();
			statusBadge.style.cssText = "display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 12px; background: #22c55e; color: white; font-weight: 500;";
			statusBadge.textContent = "✅ 已登录";

			// 用户 ID（People ID）- 始终显示，已登录时可编辑
			new Setting(containerEl)
				.setName("我的知乎 People ID")
				.setDesc("自动获取，扫码登录后填充。如未显示请手动填写")
				.addText((t) =>
					t
						.setValue(this.plugin.settings.zhihuId || "")
						.setPlaceholder("输入你的知乎 People ID")
						.onChange(async (v) => {
							this.plugin.settings.zhihuId = v;
							await this.plugin.saveSettings();
						}),
				);

			// 注销按钮（单独一行）
			const logoutBtn = containerEl.createEl("button");
			logoutBtn.style.cssText = "margin-top: 8px; padding: 6px 16px; border-radius: 6px; border: 1px solid #f87171; background: white; color: #dc2626; cursor: pointer; font-size: 13px; transition: all 0.2s;";
			logoutBtn.textContent = "注销登录";
			logoutBtn.onmouseover = () => { logoutBtn.style.background = "#fef2f2"; };
			logoutBtn.onmouseout = () => { logoutBtn.style.background = "white"; };
			logoutBtn.onclick = async () => {
				await this.plugin.logoutZhihu();
				this.display();
			};
		} else {
			// 未登录状态 - 灰色卡片
			containerEl.createDiv({ text: "账号", cls: "setting-item-heading" });

			const cardDiv = containerEl.createDiv("zhihu-login-card zhihu-card-logout");
			cardDiv.style.cssText = "border-radius: 8px; padding: 16px; margin: 8px 0; background: #f9fafb; border: 1px solid #e5e7eb;";

			// 状态标签
			const statusBadge = cardDiv.createDiv();
			statusBadge.style.cssText = "display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 12px; background: #9ca3af; color: white; font-weight: 500; margin-bottom: 12px;";
			statusBadge.textContent = "⚪ 未登录";

			// 说明文字
			const hintDiv = cardDiv.createDiv({ text: "请使用下方「扫码登录」按钮登录知乎账号。登录后 Cookie 将自动保存，同步功能即可使用。" });
			hintDiv.style.cssText = "font-size: 13px; color: #6b7280; margin-bottom: 16px; line-height: 1.5;";

			// 扫码登录按钮
			const loginBtn = cardDiv.createEl("button");
			loginBtn.style.cssText = "width: 100%; padding: 10px 16px; border-radius: 6px; border: none; background: linear-gradient(135deg, #1f2937 0%, #374151 100%); color: white; cursor: pointer; font-size: 14px; font-weight: 500; transition: all 0.2s;";
			loginBtn.textContent = "🔐 打开知乎登录页";
			loginBtn.onmouseover = () => { loginBtn.style.background = "linear-gradient(135deg, #374151 0%, #4b5563 100%)"; };
			loginBtn.onmouseout = () => { loginBtn.style.background = "linear-gradient(135deg, #1f2937 0%, #374151 100%)"; };
			loginBtn.onclick = () => {
				this.plugin.openZhihuLogin();
			};

			// 备用：手动输入 Cookie
			const divider = cardDiv.createDiv({ text: "— 备用方案 —" });
			divider.style.cssText = "text-align: center; font-size: 12px; color: #9ca3af; margin: 16px 0 12px;";

			const cookieInput = cardDiv.createEl("input");
			cookieInput.type = "text";
			cookieInput.placeholder = "粘贴 Cookie（以 z_c0= 开头）";
			cookieInput.value = this.plugin.settings.cookie || "";
			cookieInput.style.cssText = "width: 100%; padding: 8px 12px; border-radius: 6px; border: 1px solid #d1d5db; font-size: 13px; box-sizing: border-box; margin-bottom: 8px;";
			cookieInput.onchange = async () => {
				this.plugin.settings.cookie = cookieInput.value;
				await this.plugin.saveSettings();
				this.display();
			};

			const manualHint = cardDiv.createDiv({ text: "不推荐：手动输入 Cookie 易出错，仅在扫码登录不可用时使用" });
			manualHint.style.cssText = "font-size: 11px; color: #9ca3af;";
		}
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
