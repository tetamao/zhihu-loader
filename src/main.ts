import { App, Modal, Notice, Plugin, Setting, requestUrl, TFile } from 'obsidian';
import TurndownService from 'turndown';

export default class ZhihuLoaderPlugin extends Plugin {
    async onload() {
        console.log('知乎导入插件已加载');

        this.addRibbonIcon('link', '导入知乎回答', (evt: MouseEvent) => {
            this.showImportModal();
        });

        this.addCommand({
            id: 'import-zhihu-answer',
            name: '导入知乎回答',
            callback: () => {
                this.showImportModal();
            }
        });
    }

    showImportModal() {
        const modal = new ImportModal(this.app, async (url) => {
            if (url) {
                new Notice('正在抓取并处理图片...');
                await this.fetchZhihuAnswer(url);
            }
        });
        modal.open();
    }

    async fetchZhihuAnswer(url: string) {
    const match = url.match(/answer\/(\d+)/);
    if (!match) {
        new Notice('无效的知乎回答链接');
        return;
    }
    const answerId = match[1];

    try {
        const response = await requestUrl({
            url: `https://www.zhihu.com/api/v4/answers/${answerId}?include=content,author,question`,
            method: 'GET',
        });

        const data = response.json;
        const title = data.question.title;
        
        // --- 1. 强力创建文件夹 ---
        const baseFolder = "Zhihu_Imports";
        const assetFolder = `${baseFolder}/attachments`;
        
        const vault = this.app.vault;
        if (!(await vault.adapter.exists(baseFolder))) await vault.createFolder(baseFolder);
        if (!(await vault.adapter.exists(assetFolder))) await vault.createFolder(assetFolder);

        // --- 2. 预处理 HTML (彻底物理删除) ---
        const parser = new DOMParser();
        const doc = parser.parseFromString(data.content, 'text/html');
        
        // 关键：一次性找出所有图片并分流处理
        const imgs = Array.from(doc.querySelectorAll('img'));
        
        for (let i = 0; i < imgs.length; i++) {
            const img = imgs[i];
            const src = img.getAttribute('src') || '';
            const actualSrc = img.getAttribute('data-actualsrc') || img.getAttribute('data-original');

            // 核心逻辑：如果是占位图（src含svg或没有actualSrc），直接从DOM树删除
            if (src.includes('data:image/svg+xml') || !actualSrc) {
                img.remove(); 
                continue;
            }

            // 处理真实图片下载
            try {
                const imgRes = await requestUrl({ url: actualSrc, method: 'GET' });
                const ext = actualSrc.contains('webp') ? 'webp' : (actualSrc.contains('png') ? 'png' : 'jpg');
                const imgName = `zhihu_${answerId}_${i}.${ext}`;
                const imgPath = `${assetFolder}/${imgName}`;

                if (!(await vault.adapter.exists(imgPath))) {
                    await vault.createBinary(imgPath, imgRes.arrayBuffer);
                }
                
                // 将 DOM 中的 src 替换为文件名，供 Turndown 使用
                img.setAttribute('src', imgName);
            } catch (e) {
                console.error("图片下载失败:", actualSrc);
            }
        }

        // --- 3. 转换 Markdown ---
        const turndownService = new TurndownService({
            headingStyle: 'atx',
            bulletListMarker: '-'
        });

        // 强制拦截 img 标签，转为 Obsidian 内部链接
        turndownService.addRule('zhihu-img-fix', {
            filter: 'img',
            replacement: (content, node: any) => {
                const src = node.getAttribute('src');
                if (src && !src.startsWith('http')) {
                    return `![[${src}]]`; // 本地化成功
                }
                return ""; // 任何未处理成功的（包括svg）全部变为空字符串
            }
        });

        const markdownContent = turndownService.turndown(doc.body.innerHTML);

        // --- 4. 保存文件 ---
        const fileContent = `---\nsource: ${url}\nauthor: ${data.author.name}\ndate: ${new Date().toISOString().split('T')[0]}\n---\n# ${title}\n\n${markdownContent}`;
        const safeTitle = title.replace(/[\\/:*?"<>|]/g, '-');
        const filePath = `${baseFolder}/${safeTitle}_${answerId}.md`;

        const existingFile = vault.getAbstractFileByPath(filePath);
        if (existingFile instanceof TFile) {
            await vault.modify(existingFile, fileContent);
        } else {
            await vault.create(filePath, fileContent);
        }
        
        new Notice('✅ 导入完成，请检查附件文件夹');

    } catch (error) {
        console.error("插件报错:", error);
        new Notice('❌ 抓取失败，请看控制台报错');
    }
}


}

// ImportModal 类保持不变...
class ImportModal extends Modal {
    url: string;
    onSubmit: (url: string) => void;
    constructor(app: App, onSubmit: (url: string) => void) { super(app); this.onSubmit = onSubmit; }
    onOpen() {
        const { contentEl } = this;
        contentEl.createEl('h2', { text: '导入知乎回答' });
        new Setting(contentEl).setName('链接').addText((text) => text.onChange((v) => this.url = v));
        new Setting(contentEl).addButton((b) => b.setButtonText('导入').setCta().onClick(() => { this.close(); this.onSubmit(this.url); }));
    }
    onClose() { this.contentEl.empty(); }
}