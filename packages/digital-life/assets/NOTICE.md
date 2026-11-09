# 素材来源（临时）

这里的角色贴图、书房背景和字体 **来自参考项目**
[`fjdsjd/deepseek-companion-wallpaper`](https://github.com/fjdsjd/deepseek-companion-wallpaper)：

- `character/*.webp`：由该项目的 `public/assets/character/*.png` 转成 WebP（长边 940px）
- `background.webp`：由 `public/assets/background.png` 转成 WebP
- `fonts/BarlowCondensed-*.ttf`、`fonts/Oxanium-Variable.ttf`：该项目自带的 SIL OFL 字体

**这些素材是占位用的，后续会整批替换成自己的美术资源。**
该项目的代码是 MIT，但 PNG/GIF 等视觉素材在其 `ASSETS.md` 里明确不套用 MIT；
本项目目前只在私有仓库/本机范围内使用它们做界面试验，公开发布前必须替换或取得授权。

替换方式：保持文件名与目录结构不变即可（`assets/background.webp`、
`assets/character/{idle,blink,listening,petting,hugging,feeding_base}.webp`），
面板通过 `/digital-life/assets/` 路由读取，不需要改代码。
