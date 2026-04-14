import { requestUrl, type RequestUrlParam } from "obsidian";

// 默认 User-Agent
const DEFAULT_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// API 请求选项：保留 requestUrl 的原有属性，新增辅助字段
export type ApiRequestOptions = RequestUrlParam & {
	/** 强制返回原始 text（绕过 JSON 解析错误） */
	forceText?: boolean;
	/** 请求间隔（毫秒），用于防抖/限流 */
	delay?: number;
	/** 上次请求时间戳（用于计算间隔） */
	lastRequestTime?: number;
	/** 最小请求间隔（毫秒） */
	minInterval?: number;
};

/**
 * 统一 API 请求封装
 * 自动注入 Cookie 和 User-Agent，支持请求间隔控制
 */
export async function zhihuApi<T = any>(options: ApiRequestOptions): Promise<{ json?: T; text?: string; status: number }> {
	const { delay, lastRequestTime, minInterval = 500, forceText, ...requestOptions } = options;

	// 请求间隔控制（批量同步时防止限流）
	if (delay !== undefined && lastRequestTime !== undefined) {
		const elapsed = Date.now() - lastRequestTime;
		if (elapsed < minInterval) await sleep(minInterval - elapsed);
	}

	const response = await requestUrl({
		...requestOptions,
		headers: {
			"User-Agent": DEFAULT_UA,
			...(requestOptions.headers || {}),
		},
	});

	// 风控检测：非 JSON 响应可能是知乎人机验证页面
	if (response.status !== 200) return { status: response.status };
	if (forceText || !response.text) return { text: response.text, status: response.status };

	try {
		const json = JSON.parse(response.text) as T;
		return { json, status: response.status };
	} catch (e) {
		// JSON 解析失败，可能是风控页面
		console.warn("[zhihu-loader] ⚠️ API 返回非 JSON，可能触发风控:", response.text?.substring(0, 200));
		return { text: response.text, status: response.status };
	}
}

/** 休眠工具函数 */
export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 标准化 URL：移除协议前缀，便于统一处理 */
export function normalizeUrl(url: string): string;
/** 标准化 URL：移除协议前缀，便于统一处理（带清理选项） */
export function normalizeUrl(url: string, options?: { removeTrailingSlash?: boolean; lowercase?: boolean }): string;
export function normalizeUrl(url: string, options?: { removeTrailingSlash?: boolean; lowercase?: boolean }): string {
	let result = url.replace(/^https?:\/\//, ""); // 移除协议
	if (options?.lowercase) result = result.toLowerCase();
	if (options?.removeTrailingSlash) result = result.replace(/\/$/, "");
	return result;
}

/** 检测是否触发知乎风控（BEC Cookie 场景） */
export function isBECBlocked(text: string): boolean {
	return text.includes("captcha") || text.includes("BEC=") || text.includes("验证") || text.includes("人机");
}
