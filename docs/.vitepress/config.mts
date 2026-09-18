import { defineConfig } from "vitepress";

// 部署到 GitHub Pages 的路径：https://<user>.github.io/chiperf/docs/
const DOCS_BASE = process.env.DOCS_BASE ?? '/chiperf/docs/'

export default defineConfig({
    base: DOCS_BASE,
    lang: 'zh-CN',
    title: 'Chiperf',
    description: '硬件微架构性能分析与可视化的通用文件格式',
    cleanUrls: true,
    lastUpdated: true,
    // 内容目录叫 docs/，这里把路由前缀去掉，页面直接位于 .../docs/ 下
    rewrites: (id) => id.replace(/^docs\//, ''),
    // .chiperf 语料以静态文件形式经 public/ 提供，不是站点页面
    ignoreDeadLinks: [/\.chiperf$/],
    head: [
        ['meta', { name: 'theme-color', content: '#6f42c1' }],
    ],
    markdown: {
        // chiperf / ebnf 无内置语法高亮：注册为纯文本语法，避免构建告警
        languages: [
            { name: 'chiperf', scopeName: 'source.chiperf', patterns: [] },
            { name: 'ebnf', scopeName: 'source.ebnf', patterns: [] },
            { name: 'mermaid', scopeName: 'source.mermaid', patterns: [] },
        ],
    },
    themeConfig: {
        nav: [
            { text: 'Spec V1.0', link: '/spec/v1.0' },
            { text: '可视化', link: 'https://hamster5295.github.io/chiperf/visualize' },
        ],
        sidebar: [
            {
                text: '开始',
                items: [
                    { text: '这是什么？', link: '/intro' },
                    { text: '工具链', link: '/toolchain' },
                    { text: '示例', link: '/examples' },
                ],
            },
            {
                text: '事件',
                items: [
                    { text: '总览', link: '/events/' },
                    { text: 'clk 时钟沿', link: '/events/clk' },
                    { text: 'cnt 计数器', link: '/events/cnt' },
                    { text: 'val 数值采样', link: '/events/val' },
                    { text: 'pip 在飞条目', link: '/events/pip' },
                    { text: 'fsm 状态机', link: '/events/fsm' },
                    { text: 'evt 瞬时事件', link: '/events/evt' },
                    { text: 'msg 自由文本', link: '/events/msg' },
                    { text: 'rst 系统复位', link: '/events/rst' },
                ],
            },
            {
                text: 'Spec',
                items: [{ text: 'V1.0', link: '/spec/v1.0' }],
            },
        ],
        outline: { level: [2, 3], label: '本页目录' },
        search: { provider: 'local' },
        editLink: {
            pattern: 'https://github.com/Hamster5295/chiperf/edit/main/docs/:path',
            text: '在 GitHub 上编辑此页',
        },
        docFooter: { prev: '上一篇', next: '下一篇' },
        lastUpdated: { text: '最后更新于' },
        returnToTopLabel: '回到顶部',
        sidebarMenuLabel: '目录',
        darkModeSwitchLabel: '外观',
        outlineLabel: '本页目录',

        socialLinks: [{ icon: "github", link: "https://github.com/Hamster5295/chiperf" }],
    },
})
