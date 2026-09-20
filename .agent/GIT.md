# git

本文档表示项目的 git 使用规范


## 提交时机

当项目有进展时，有文件修改时, **必须** 合理执行 git commit 提交

提交应当 **原子化**, 即每次提交都仅包含 1 项 feature/enhancement/refactor/fix


## 提交信息

提交信息必须按照如下规范: 
- feat: <添加的新功能>
- refactor: <重构的内容>
- fix: <修复的bug>
- build: <构建系统或流程改进>
- ci: <ci更新>
- chore: <杂项>

提交信息 **必须使用英文**