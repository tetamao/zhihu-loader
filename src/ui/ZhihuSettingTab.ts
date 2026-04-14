import {
	App,
	Modal,
	PluginSettingTab,
	Setting,
} from "obsidian";
import type { ZhihuPluginInstance } from "../types";

/**
 * 知乎插件设置页面
 * 包含登录状态卡片、Cookie输入、基础配置
 */
export class ZhihuSettingTab extends PluginSettingTab {
	plugin: ZhihuPluginInstance;
	constructor(app: App, plugin: ZhihuPluginInstance) {
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

			// People ID 编辑框
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

			// 注销按钮
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
			// 未登录状态
			containerEl.createDiv({ text: "账号", cls: "setting-item-heading" });

			const cardDiv = containerEl.createDiv("zhihu-login-card zhihu-card-logout");
			cardDiv.style.cssText = "border-radius: 8px; padding: 16px; margin: 8px 0; background: #f9fafb; border: 1px solid #e5e7eb;";

			const statusBadge = cardDiv.createDiv();
			statusBadge.style.cssText = "display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 12px; background: #9ca3af; color: white; font-weight: 500; margin-bottom: 12px;";
			statusBadge.textContent = "⚪ 未登录";

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

		// ========== 基础配置 ==========
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

/**
 * 单篇回答导入弹窗
 */
export class ImportModal extends Modal {
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
