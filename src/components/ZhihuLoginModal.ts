import { Modal, Notice, App, requestUrl } from "obsidian";

// 知乎登录弹窗：创建 BrowserWindow 加载知乎登录页，轮询检测 z_c0 Cookie
export class ZhihuLoginModal extends Modal {
	app: App;
	onSuccess: (cookie: string, userName?: string, peopleId?: string, avatarUrl?: string) => void;
	onCancel: () => void;

	private checkInterval: number | null = null;
	private modalWindow: any = null;
	private isHandled: boolean = false;
	private readonly CHECK_INTERVAL = 500;       // ms
	private readonly MAX_WAIT_TIME = 5 * 60 * 1000; // 5 分钟超时
	private waitStartTime = 0;

	constructor(app: App, onSuccess: (cookie: string, userName?: string, avatarUrl?: string) => void, onCancel: () => void) {
		super(app);
		this.app = app;
		this.onSuccess = onSuccess;
		this.onCancel = onCancel;
	}

	async onOpen() {
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createDiv({ text: "知乎登录", cls: "zhihu-login-title" });
		contentEl.createDiv({
			text: "即将打开知乎登录页面，请使用知乎 App 扫码登录。登录成功后窗口将自动关闭。",
			cls: "zhihu-login-desc",
		});
		contentEl.createDiv({
			text: "⏳ 等待扫码中...",
			cls: "zhihu-login-status",
			attr: { id: "zhihu-login-status" },
		});

		this.openBrowserWindow();
	}

	private openBrowserWindow() {
		// 防止重复打开窗口
		if (this.modalWindow && !this.modalWindow.isDestroyed()) {
			console.log("[zhihu-loader] 登录窗口已存在，跳过重复创建");
			return;
		}

		try {
			const { remote } = require("electron");
			const { BrowserWindow } = remote;
			const currentWindow = remote.getCurrentWindow();

			this.modalWindow = new BrowserWindow({
				width: 960,
				height: 600,
				parent: currentWindow,
				modal: true,
				show: false,
				webPreferences: {
					nodeIntegration: false,
					contextIsolation: true,
					webSecurity: true,
				},
			});

			// 窗口准备好再显示
			this.modalWindow.once("ready-to-show", () => {
				if (!this.modalWindow.isDestroyed()) {
					this.modalWindow.show();
				}
			});

			// 等页面 DOM 加载完成后再开始轮询（避免初始空状态误判）
			this.modalWindow.webContents.once("did-finish-load", () => {
				this.waitStartTime = Date.now();
				this.startCookieCheck();
			});

			// 加载知乎登录页
			this.modalWindow.loadURL("https://www.zhihu.com/signin?type=qr");
		} catch (e) {
			console.error("[zhihu-loader] BrowserWindow 打开失败:", e);
			new Notice("❌ 打开登录窗口失败，请确保在 Obsidian 桌面版中使用");
			this.close();
			this.onCancel();
		}
	}

	private startCookieCheck() {
		if (this.isHandled) return;
		if (this.checkInterval) {
			clearInterval(this.checkInterval);
		}

		this.checkInterval = window.setInterval(async () => {
			if (this.isHandled) {
				this.stopCookieCheck();
				return;
			}

			// 超时检测
			if (Date.now() - this.waitStartTime > this.MAX_WAIT_TIME) {
				this.isHandled = true;
				this.stopCookieCheck();
				new Notice("⏰ 登录超时，请重试");
				this.close();
				this.onCancel();
				return;
			}

			// 确保 session 可用
			if (!this.modalWindow || this.modalWindow.isDestroyed()) return;
			try {
				// eslint-disable-next-line @typescript-eslint/no-unused-vars
				const _session = this.modalWindow.webContents.session;
				// session 存在，继续
			} catch (_e) {
				return;
			}

			const result = await this.checkLoginCookie();
			if (result.success && result.cookie) {
				this.isHandled = true;
				this.stopCookieCheck();
				this.close();
				this.onSuccess(result.cookie, result.userName, result.peopleId, result.avatarUrl);
			}
		}, this.CHECK_INTERVAL);
	}

	private stopCookieCheck() {
		if (this.checkInterval) {
			clearInterval(this.checkInterval);
			this.checkInterval = null;
		}
		if (this.modalWindow && !this.modalWindow.isDestroyed()) {
			try {
				this.modalWindow.close();
			} catch (_e) {
				// ignore
			}
			this.modalWindow = null;
		}
	}

	private async checkLoginCookie(): Promise<{ success: boolean; cookie?: string; userName?: string; peopleId?: string; avatarUrl?: string }> {
		try {
			if (!this.modalWindow || this.modalWindow.isDestroyed()) return { success: false };

			// === 快速路径：cookie 中心检测（优先于 DOM 启发式）===
			// 解决"弹窗已是登录态、但 URL 停在 /signin，DOM 信号全为未登录特征"导致永远等待扫码的问题。
			// 只要会话里有 z_c0 就直接读 cookie 并校验，不依赖任何页面 DOM/标题。
			const sessionLogin = await this.tryReadSessionLogin();
			if (sessionLogin.success) {
				return sessionLogin;
			}

			// ============================================================
			// 策略：从页面 localStorage 直接读取登录态
			// 原因：
			//   1. session.cookies.get() 可能读不到 z_c0（httpOnly/特殊域）
			//   2. zhihu 的 CORS 阻止注入脚本的 fetch() 调用
			//   3. localStorage 是页面自身写入的，executeJavaScript 可直接读
			// ============================================================

			const pageState: any = await this.modalWindow.webContents.executeJavaScript(`
				(function() {
					try {
						// 知乎登录态检测策略 v2
						// 原因：z_c0 是 httpOnly cookie，document.cookie 读不到
						// 策略：通过页面标题、DOM 元素、JS 全局变量判断登录状态

						const pageTitle = document.title;
						const bodyClasses = document.body.className;
						const url = window.location.href;

						// 1. 页面标题特征：已登录显示"首页"或"消息"，未登录显示"知乎 - 有问题，就会有答案"
						const isHomePage = pageTitle.includes("首页") || pageTitle.includes("消息") || pageTitle.includes("推荐");
						const isLoggedInUrl = url.includes("/signin") === false && (url === "https://www.zhihu.com/" || url.includes("/hot") || url.includes("/recommend"));

						// 2. DOM 特征：已登录页面有用户头像、通知图标、搜索框等
						const hasUserAvatar = !!document.querySelector('[class*="Avatar"], [class*="avatar"], .Topstory-nav-userAvatar, .AppHeader-profile');
						const hasNotification = !!document.querySelector('[class*="notification"], [class*="Notification"], .AppHeader-notifications');
						const hasSearchBox = !!document.querySelector('[class*="SearchBar"], [class*="search"], input[placeholder*="搜索"]');

						// 3. 全局 JS 变量：知乎会把用户信息写入 window 对象
						let globalUser = null;
						try {
							// 尝试读取知乎的各种全局变量
							globalUser = window.__INITIAL_STATE__?.user ||
										window.__NEXT_DATA__?.props?.pageProps?.user ||
										window.zhihu_user ||
										window._user;
						} catch (_e) {}

						// 4. 从 localStorage 读取（备用方案）
						let lsData = {};
						try {
							for (let i = 0; i < localStorage.length; i++) {
								const key = localStorage.key(i);
								if (key && (key.includes("user") || key.includes("token") || key.includes("auth") || key.includes("session"))) {
									lsData[key] = localStorage.getItem(key);
								}
							}
						} catch (_e) {}

						// 综合判断登录状态
						const isLoggedIn = isHomePage || hasUserAvatar || globalUser || (isLoggedInUrl && hasSearchBox);

						// 尝试获取用户名（多种来源）
						let userName = "";
						if (globalUser?.name) userName = globalUser.name;
						else if (globalUser?.fullname) userName = globalUser.fullname;
						else if (globalUser?.url_token) userName = globalUser.url_token;

						// 尝试获取 people_id (url_token)
						let peopleId = globalUser?.url_token || globalUser?.id || "";

						// 从 DOM 提取：右上角用户卡片
						try {
							const userCard = document.querySelector('[class*="UserItem"], [class*="user-item"], .Topstory-userCard, .AppHeader-profile, [class*="ProfileHeader"]');
							if (userCard) {
								const nameEl = userCard.querySelector('[class*="name"], [class*="Name"], span, a');
								if (nameEl && !userName) {
									userName = nameEl.textContent?.trim() || "";
								}
								const linkEl = userCard.querySelector('a[href*="/people/"]');
								if (linkEl && !peopleId) {
									const match = linkEl.href.match(/\/people\/([^/?#]+)/);
									if (match) peopleId = match[1];
								}
							}
						} catch (_e) {}

						// 从 URL 提取 people_id（已登录后 URL 通常是 /people/xxx）
						if (!peopleId && url.includes("/people/")) {
							const match = url.match(/\/people\/([^/?#]+)/);
							if (match) peopleId = match[1];
						}

						// 尝试从 localStorage 中解析出用户信息
						try {
							for (let i = 0; i < localStorage.length; i++) {
								const key = localStorage.key(i);
								if (!key) continue;
								const val = localStorage.getItem(key);
								if (!val) continue;
								// 查找包含 name 或 url_token 的 JSON 值
								if (val.includes('"name"') || val.includes('"url_token"')) {
									try {
										const parsed = JSON.parse(val);
										if (!userName && parsed.name) userName = parsed.name;
										if (!peopleId && parsed.url_token) peopleId = parsed.url_token;
									} catch (_e2) {}
								}
							}
						} catch (_e) {}

						// 尝试从页面脚本标签中提取
						try {
							const scripts = document.querySelectorAll('script');
							for (const script of scripts) {
								const text = script.textContent || "";
								if (text.includes('"url_token"') || text.includes('"name"')) {
									const match = text.match(/"url_token"\s*:\s*"([^"]+)"/);
									if (match && !peopleId) peopleId = match[1];
									const nameMatch = text.match(/"name"\s*:\s*"([^"]+)"/);
									if (nameMatch && !userName) userName = nameMatch[1];
									if (peopleId && userName) break;
								}
							}
						} catch (_e) {}

						// 尝试获取头像
						let avatarUrl = globalUser?.avatar_url || "";

						return {
							isLoggedIn: isLoggedIn,
							userName: userName,
							peopleId: peopleId,
							avatarUrl: avatarUrl,
							pageTitle: pageTitle,
							url: url,
							signals: {
								isHomePage: isHomePage,
								isLoggedInUrl: isLoggedInUrl,
								hasUserAvatar: hasUserAvatar,
								hasNotification: hasNotification,
								hasSearchBox: hasSearchBox,
								hasGlobalUser: !!globalUser
							},
							lsData: lsData
						};
					} catch(e) {
						return { error: e.message };
					}
				})()
			`).catch((e: any) => ({ error: "executeJavaScript failed: " + e.message }));

			console.log("[zhihu-loader] 页面状态:", JSON.stringify(pageState));

			if (!pageState || pageState.error) {
				console.warn("[zhihu-loader] 无法读取页面状态:", pageState?.error);
				return { success: false };
			}

			// 综合判断是否已登录
			if (!pageState.isLoggedIn) {
				console.log("[zhihu-loader] 页面未登录，等待扫码...");
				return { success: false };
			}

			// DOM 信号显示已登录：统一转由会话 cookie 读取与校验（含 z_c0 + /api/v4/me）
			return await this.tryReadSessionLogin();
		} catch (e) {
			console.error("[zhihu-loader] 检测失败:", e);
			return { success: false };
		}
	}

	/**
	 * 从 Electron session 直接读取知乎登录态（cookie 中心检测）。
	 * 不依赖任何页面 DOM/标题，只要会话里有 z_c0 即可识别，
	 * 用于：1) 打开弹窗时已是登录态；2) 扫码后 z_c0 写入 session。
	 * 校验：用 z_c0 拼 cookie 调 /api/v4/me，通过则视为有效登录。
	 */
	private async tryReadSessionLogin(): Promise<{ success: boolean; cookie?: string; userName?: string; peopleId?: string; avatarUrl?: string }> {
		try {
			if (!this.modalWindow || this.modalWindow.isDestroyed()) return { success: false };
			const session = this.modalWindow.webContents.session;
			const domains = ["zhihu.com", ".zhihu.com", "www.zhihu.com", "link.zhihu.com"];
			const allCookies: any[] = [];
			for (const domain of domains) {
				try {
					const cookies = await session.cookies.get({ domain });
					if (cookies?.length) allCookies.push(...cookies);
				} catch (_e) {}
			}
			// 去重
			const cookieMap = new Map<string, any>();
			for (const c of allCookies) cookieMap.set(c.name, c);
			const uniqueCookies = Array.from(cookieMap.values());

			const z_c0 = uniqueCookies.find((c: any) => c.name === "z_c0");
			if (!z_c0 || z_c0.value.length < 20) {
				return { success: false };
			}

			const cookieStr = uniqueCookies.map((c: any) => `${c.name}=${c.value}`).join("; ");

			// 用 /api/v4/me 校验 cookie 是否有效，并拿到可靠的用户信息
			let userName = "知乎用户";
			let peopleId = "";
			let avatarUrl = "";
		try {
			// 注意：必须用 Obsidian 的 requestUrl，不能用浏览器 fetch。
			// 浏览器 fetch 会静默丢弃手动设置的 Cookie 请求头（forbidden header），
			// 导致 /api/v4/me 收到的是未携带 cookie 的请求 -> 401。
			// requestUrl 走 node 网络层，可正常携带 Cookie 头（main.ts 同源校验已验证）。
			const meRes = await requestUrl({
				url: "https://www.zhihu.com/api/v4/me",
				method: "GET",
				headers: {
					Cookie: cookieStr,
					"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
				},
			});
			if (meRes.status >= 200 && meRes.status < 300) {
				const me: any = meRes.json;
				userName = me?.name || userName;
				peopleId = me?.url_token || "";
				avatarUrl = me?.avatar_url || "";
			} else {
				// cookie 实际无效，不返回登录态
				console.log("[zhihu-loader] z_c0 存在但 /api/v4/me 校验失败:", meRes.status);
				return { success: false };
			}
		} catch (_e) {
			// 校验请求失败（网络等）：降级信任 z_c0 存在（强登录信号）
			console.warn("[zhihu-loader] /api/v4/me 校验异常，降级信任 z_c0:", (_e as Error)?.message);
		}

			console.log("[zhihu-loader] ✅ 会话 cookie 检测到登录态，用户:", userName, "people:", peopleId);
			return { success: true, cookie: cookieStr, userName, peopleId, avatarUrl };
		} catch (e) {
			console.error("[zhihu-loader] tryReadSessionLogin 失败:", e);
			return { success: false };
		}
	}

	onClose() {
		this.isHandled = true;
		this.stopCookieCheck();
		const { contentEl } = this;
		contentEl.empty();
	}
}
