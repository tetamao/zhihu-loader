import { Plugin, TFile } from "obsidian";

// ============================================================
// 插件设置
// ============================================================
export interface ZhihuSettings {
	downloadFolder: string;
	cookie: string;
	zhihuId: string;
	enableRecommendSync: boolean;
	enableGoodsSync: boolean;
	userName?: string;
	userAvatar?: string;
	cookieValidUntil?: number;
}

export const DEFAULT_SETTINGS: ZhihuSettings = {
	downloadFolder: "Zhihu_Imports",
	cookie: "",
	zhihuId: "",
	enableRecommendSync: false,
	enableGoodsSync: false,
};

// ============================================================
// creationsCache 条目结构
// ============================================================
export interface CreationsCacheEntry {
	voteupCount: number;
	commentCount: number;
	collectCount: number;
	readCount: number;
	updatedTime: number; // 知乎最后更新时间（Unix 秒）
	questionId: string; // 所属问题 ID
	title: string; // 问题标题（用于文件 frontmatter）
}

// ============================================================
// 回答同步结果
// ============================================================
export type SyncResult = "SUCCESS" | "SKIPPED" | "FAILED";

// ============================================================
// processAndSaveAnswer 参数
// ============================================================
export interface ProcessAnswerParams {
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
}

// ============================================================
// 回答列表条目
// ============================================================
export interface AnswerListItem {
	id: string;
	questionId: string;
	updatedTime: number;
	title: string;
}

// ============================================================
// 统计数据（三级降级策略返回值）
// ============================================================
export interface AnswerStats {
	voteupCount: number;
	commentCount: number;
	collectCount: number;
	readCount: number;
}

// ============================================================
// 插件实例接口（用于 UI 模块解耦循环依赖）
// ============================================================
export interface ZhihuPluginInstance extends Plugin {
	settings: ZhihuSettings;
	settingTab?: unknown;
	isZhihuLoggedIn(): boolean;
	openZhihuLogin(): void;
	logoutZhihu(): Promise<void>;
	saveSettings(): Promise<void>;
}
