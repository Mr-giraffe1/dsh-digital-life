# 素材来源与授权（重要）

`character/*.webp`、`background.webp`、`fonts/*.ttf` **不是本项目的原创素材**，它们来自：

- 来源项目：[`fjdsjd/deepseek-companion-wallpaper`](https://github.com/fjdsjd/deepseek-companion-wallpaper)
- 转换：`public/assets/character/*.png` → WebP（长边 940px），`public/assets/background.png` → WebP
- 字体：该项目自带的 SIL OFL 字体（Barlow Condensed / Oxanium）

**授权状态**：该项目**代码是 MIT，但 PNG/GIF 等视觉素材在其 `ASSETS.md` 里明确不套用 MIT**。
因此 `assets/` 下的文件**不属于本项目的 MIT 授权范围**，这里附带它们只是为了展示界面的样子。
**请不要把 `assets/` 当成可复用的开源素材**——要在自己的项目里用，请向原作者取得授权，
或者换成自己拥有版权的素材。

**替换方式**（换图不用改代码，保持文件名与目录结构即可）：

```
assets/background.webp
assets/character/{idle,blink,listening,petting}.webp    ← 面板当前引用这四张
assets/character/{hugging,feeding_base}.webp            ← 预留，未引用
assets/fonts/{BarlowCondensed-Regular,BarlowCondensed-Medium,Oxanium-Variable}.ttf
```

尺寸建议：立绘方形、长边 940px、带透明通道；背景 16:9 左右。
面板通过 `/digital-life/assets/` 路由读取，替换后刷新页面生效。
