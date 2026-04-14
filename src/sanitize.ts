/**
 * 文件名 sanitize 工具函数
 * 规则：问号（半角/全角、任意位置）原样保留，其他文件系统非法字符替换为下划线
 */

/**
 * 将标题处理为安全的文件名
 * @param title 原始标题
 * @param maxLength 最大长度（默认 120）
 */
export function sanitizeTitle(title: string, maxLength: number = 120): string {
	return title
		.replace(/[\\/:*?"<>|#\[\]]/g, "_") // 替换非法字符为下划线（问号保留）
		.replace(/_+/g, "_")                 // 合并连续下划线
		.replace(/^_|_$/g, "")              // 去除首尾下划线
		.substring(0, maxLength);           // 截断
}
