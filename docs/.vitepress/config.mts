import { defineConfig } from "vitepress";

export default defineConfig({
    lang: 'zh-CN',
    title: 'Chiperf',
    description: '硬件微架构性能分析与可视化的通用文件格式',
    cleanUrls: true,
    lastUpdated: true,
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
            { text: '指南', link: '/docs/guide' },
            { text: '规范', link: '/docs/spec' },
            { text: '示例', link: '/docs/examples/' },
        ],
        sidebar: [
            {
                text: '开始',
                items: [
                    { text: '这是什么？', link: '/docs/intro' },
                    { text: '工具链', link: '/docs/toolchain' },
                    { text: '示例', link: '/docs/examples' }
                ],
            },
            {
                text: '事件',
                items: [
                    { text: '总览', link: '/docs/events/' },
                    { text: 'clk 时钟沿', link: '/docs/events/clk' },
                    { text: 'cnt 计数器', link: '/docs/events/cnt' },
                    { text: 'val 数值采样', link: '/docs/events/val' },
                    { text: 'pip 在飞条目', link: '/docs/events/pip' },
                    { text: 'fsm 状态机', link: '/docs/events/fsm' },
                    { text: 'evt 瞬时事件', link: '/docs/events/evt' },
                    { text: 'msg 自由文本', link: '/docs/events/msg' },
                    { text: 'rst 系统复位', link: '/docs/events/rst' },
                ],
            },
            {
                text: 'Spec',
                items: [{ text: 'V1.0', link: '/docs/spec/v1.0' }],
            },
        ],
        outline: { level: [2, 3], label: '本页目录' },
        search: { provider: 'local' },
        editLink: {
            pattern: 'https://codeberg.org/hamster5295/chiperf/_edit/main/docs/:path',
            text: '在 Codeberg 上编辑此页',
        },
        docFooter: { prev: '上一篇', next: '下一篇' },
        lastUpdated: { text: '最后更新于' },
        returnToTopLabel: '回到顶部',
        sidebarMenuLabel: '目录',
        darkModeSwitchLabel: '外观',
        outlineLabel: '本页目录',
    },
})
