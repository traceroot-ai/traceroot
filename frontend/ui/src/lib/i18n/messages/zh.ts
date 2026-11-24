import type { PartialMessages } from "./en";

// Wording follows Dify's Simplified Chinese where it has the same term: workspace 工作空间,
// dataset 数据集, log out 登出, account 账户. Project is 项目.
// Terms specific to traceroot stay in English: trace, span, session, detector, signal, eval.
// The brand is always "traceroot", lowercase.
export const zh: PartialMessages = {
  common: {
    cancel: "取消",
    create: "创建",
    creating: "创建中...",
    name: "名称",
    created: "创建时间",
    updated: "更新时间",
    settings: "设置",
    settingsFor: "{name} 的设置",
    viewOnly: "只读",
  },
  nav: {
    home: "首页",
    observe: "观察",
    detect: "检测",
    verify: "验证",
    datasets: "数据集",
    workspaces: "工作空间",
    support: "支持",
    homeLabel: "traceroot 首页",
  },
  account: {
    menu: "账户菜单",
    fallbackName: "用户",
    theme: "主题",
    themeLight: "浅色",
    themeDark: "深色",
    themeSystem: "跟随系统",
    language: "语言",
    supportConsole: "支持控制台",
    activeSessions: "活跃会话",
    logOut: "登出",
    exitImpersonation: "退出模拟登录",
  },
  workspaces: {
    title: "工作空间",
    loading: "正在加载工作空间...",
    emptyTitle: "还没有工作空间",
    emptyText: "创建你的第一个工作空间来开始使用",
    newWorkspace: "新建工作空间",
    newDescription: "创建一个新的工作空间，用来管理你的项目和团队成员。",
    namePlaceholder: "工作空间名称",
  },
  projects: {
    title: "项目",
    loading: "正在加载项目...",
    emptyTitle: "还没有项目",
    emptyText: "创建你的第一个项目，开始记录 trace",
    newProject: "新建项目",
    createTitle: "创建项目",
    createDescription: "创建一个新的项目，开始记录你的 AI agent 的 trace。",
    namePlaceholder: "项目名称",
  },
};
