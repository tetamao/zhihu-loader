# Obsidian Zhihu Loader

[![GitHub license](https://badgen.net/github/license/tetamao/zhihu-loader)](https://github.com/tetamao/zhihu-loader/blob/main/LICENSE)
[![GitHub latest release](https://badgen.net/github/release/tetamao/zhihu-loader/latest/)](https://github.com/tetamao/zhihu-loader/releases)
[![GitHub all releases](https://img.shields.io/github/downloads/tetamao/zhihu-loader/total.svg)](https://github.com/tetamao/zhihu-loader/releases)

Obsidian 知乎同步插件 — 将知乎回答转化为结构化的本地 Markdown 笔记，实现知识的永久存档。支持扫码登录、增量同步、深度元数据抓取、图片本地化。

---

## 功能

- **全量/增量同步**：一键备份知乎回答，已同步且未更新的回答零请求，大幅降低 Cookie 被风控风险
- **扫码登录**：Electron BrowserWindow 扫码授权，无需手动复制粘贴 Cookie
- **深度元数据**：点赞数、评论数、收藏数、阅读数、话题标签、更新时间
- **点赞数实时同步**：本地 frontmatter 与知乎数据实时比对，点赞数变化时自动更新本地文件
- **图片本地化**：自动下载图片至 attachments 文件夹，解决防盗链困扰
- **文件名标题化**：同步文件名为 `{问题标题}.md`，更直观易读
- **好物推荐抓取**：MCN 级接口自动抓取高价值问题，生成含浏览量、回答数的 MD 表格
- **联动同步**：支持在同步回答时自动触发推荐/好物抓取

---

## 安装

### 手动安装

1. 到 [Releases](https://github.com/tetamao/zhihu-loader/releases) 下载最新版本 `main.js`、`manifest.json`
2. 放入 Obsidian 插件目录 `.obsidian/plugins/zhihu-loader/`
3. 在 Obsidian 设置中启用插件

> 要求：Obsidian 0.15.0 及以上版本

---

## 配置

1. 点击左侧边栏的 **知乎图标**，进入插件设置页面
2. 点击「打开知乎登录页」，使用知乎 App 扫码授权，Cookie 和 People ID 将自动保存
3. 如扫码登录不可用，可在设置页手动粘贴 Cookie（备用方案）
4. 自定义根目录名称（默认为 `Zhihu_Imports`）

---

## 使用

### 同步我的回答

点击侧边栏的 **循环图标**，插件自动同步所有已发布回答。

同步逻辑：
- 优先基于 `updated_time` 跳过内容未更新的条目（零 API 请求）
- 同时比对本地 frontmatter 与知乎数据的统计字段，点赞数等变化时自动更新文件

### 单篇导入

点击侧边栏的 **链接图标**，粘贴特定的知乎回答链接，进行针对性抓取。

### 获取推荐问题

在设置页点击「获取今日创作者中心推荐」或「获取好物推荐」，自动生成日报文件。

---

## 文件结构

插件会自动维护以下目录：

```
Zhihu_Imports/
├── answers/       # 同步的回答 MD 文件
├── attachments/   # 本地化的图片资源
├── recommend/     # 创作者推荐日报
└── Goods/         # 好物推荐日报
```

每篇回答生成规范的 Properties 区域：

```yaml
---
标题: "问题标题"
url: https://www.zhihu.com/...
answerId: "xxx"
话题: ['[[职场]]', '[[成长]]']
点赞数: 1024
评论数: 56
收藏数: 23
阅读数: 10086
作者: 用户名
日期: 2024-01-01
更新: 2024-03-20
---
```

> 注意：`收藏数` 和 `阅读数` 来自知乎 `creations/v2/all` 接口，极老或已下架回答可能为 0。

---

## 更新历史

https://github.com/tetamao/zhihu-loader/releases

---

## 已知问题

- Cookie 长期不使用可能会触发风控，需要在设置页重新扫码登录
- `收藏数` 和 `阅读数` 依赖知乎 `creations/v2/all` 接口，极老/已下架回答可能为 0（知乎 API 限制）
- 偶尔网络波动导致同步失败，重新点击同步即可，已同步文件不会重复写入

---

## TODO

- [ ] 支持回答内容的变更检测与自动更新
- [ ] 同步进度可视化（显示当前进度/总数）
- [ ] 设置页面增加模板自定义功能
- [ ] 支持回答草稿的导出
- [ ] 导出热门评论

---

## 免责声明

本工具仅用于个人知识管理与备份。请尊重原平台版权及社区规范，切勿用于商业用途或非法爬取。
