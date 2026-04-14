import { zhihuApi, isBECBlocked } from "./api/client";
import type { AnswerStats, CreationsCacheEntry } from "./types";

// 三级降级策略：缓存 → 问题列表翻页 → link_card_infos 兜底

const DEFAULT_STATS: AnswerStats = {
	voteupCount: 0,
	commentCount: 0,
	collectCount: 0,
	readCount: 0,
};

/**
 * 获取回答统计数据（三级降级策略）
 * @param answerId 回答 ID
 * @param questionId 问题 ID
 * @param answerUrl 回答完整 URL
 * @param cookie 知乎 Cookie
 * @param cachedStats creationsCache 中的缓存数据（如有）
 */
export async function fetchAnswerStats(
	answerId: string,
	questionId: string,
	answerUrl: string,
	cookie: string,
	cachedStats?: CreationsCacheEntry,
): Promise<AnswerStats> {
	// 第一级：缓存命中，直接返回
	if (cachedStats) {
		console.log(`[zhihu-loader] 缓存命中: ${answerId} - ${cachedStats.voteupCount} 赞`);
		return {
			voteupCount: cachedStats.voteupCount,
			commentCount: cachedStats.commentCount,
			collectCount: cachedStats.collectCount,
			readCount: cachedStats.readCount,
		};
	}

	let result = { ...DEFAULT_STATS };
	let found = false;

		// 第二级：问题回答列表翻页
	for (let pageOffset = 0; pageOffset < 200 && !found; pageOffset += 20) {
		try {
			const { json: listData } = await zhihuApi<{ data?: any[]; paging?: { is_end: boolean } }>({
				url: `https://www.zhihu.com/api/v4/questions/${questionId}/answers?include=data%5B*%5D.voteup_count,data%5B*%5D.comment_count,data%5B*%5D.thanks_count,data%5B*%5D.id&limit=20&offset=${pageOffset}&sort_by=created_time`,
				headers: { Cookie: cookie },
			});
			if (!listData) break;
			const match = listData.data?.find((a: any) => String(a.id) === answerId);
			if (match) {
				result.voteupCount = match.voteup_count ?? 0;
				result.commentCount = match.comment_count ?? 0;
				found = true;
				console.log(`[zhihu-loader] 翻页命中: ${answerId} - ${result.voteupCount} 赞`);
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
			const { text: cardText } = await zhihuApi({
				url: `https://www.zhihu.com/api/v4/editor/link_card_infos?scene=pcweb&urls=${cardUrl}`,
				headers: { Cookie: cookie },
				forceText: true,
			});
			if (cardText && !isBECBlocked(cardText)) {
				const cardData = JSON.parse(cardText);
				const firstUrl = Object.keys(cardData)[0];
				const cardInfo = firstUrl ? cardData[firstUrl] : null;
				if (cardInfo?.extra_info) {
					const extraInfo = JSON.parse(cardInfo.extra_info);
					const desc = (extraInfo.desc || "").replace(/<[^>]+>/g, "").trim();
					const voteupMatch = desc.match(/(\d+)\s*赞同/);
					const commentMatch = desc.match(/(\d+)\s*评论/);
					if (voteupMatch) result.voteupCount = parseInt(voteupMatch[1]) || 0;
					if (commentMatch) result.commentCount = parseInt(commentMatch[1]) || 0;
					console.log(`[zhihu-loader] link_card_infos 兜底: ${desc}`);
				}
			}
		} catch (e) {
			console.warn(`[zhihu-loader] link_card_infos 获取失败:`, e);
		}
	}

	return result;
}
