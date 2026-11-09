/**
 * Client half of dsh-digital-life — 书房控制台.
 *
 * A window onto a process that keeps running when this panel is closed. It reads
 * one snapshot route and posts a small set of whitelisted actions; it never owns
 * her state. Replies arrive as finished sentences over SSE, never as token
 * deltas: the voice guard runs on the whole reply before anything is shown.
 *
 * Visual language: reproduced from `deepseek-companion-wallpaper` (MIT) — the
 * 550W-style HUD laid over a warm study: condensed uppercase rail labels, hairline
 * rules, L-bracket section corners, readout chips, barcodes, a three-column
 * layout, and a clock/day-track rail across the bottom.
 *
 * NO ASSETS ARE BORROWED. That project's PNG/GIF art is explicitly NOT MIT (see
 * its ASSETS.md) and its fonts keep their own OFL. Everything here is CSS and
 * hand-written SVG: the room is drawn, the type falls back to Bahnschrift /
 * Microsoft YaHei, and the portrait frame is deliberately empty until you drop
 * your own art in.
 */

window.__ModuleLoader__.load({
	id: 'dsh-digital-life',
	factory: (require) => {
		var exports = {}

		/** React seed module; the panel is skipped when it is unavailable. */
		let React
		try {
			React = require('react')
		} catch {
			React = void 0
		}

		/** Set once in apply; only components that render ever need it. */
		let h

		const STATE_URL = '/digital-life/state.json'
		const STREAM_URL = '/digital-life/stream'
		const ACTION_URL = '/digital-life/action'
		const TRANSCRIPT_URL = '/digital-life/transcript.json'
		const STYLE_ID = 'dsh-digital-life-style'

		/**
		 * The stylesheet.
		 *
		 * Tokens follow the reference simulator's palette and type scale: light
		 * grey ink on a dark ground, condensed uppercase, 0.6-0.7 alpha hairlines,
		 * translucent readout chips, one saturated red block (here: her state).
		 */
		const CSS = `
			@font-face {
				font-family: 'Simulator Condensed';
				src: url('/digital-life/assets/fonts/BarlowCondensed-Regular.ttf') format('truetype');
				font-weight: 400;
				font-display: swap;
			}
			@font-face {
				font-family: 'Simulator Condensed';
				src: url('/digital-life/assets/fonts/BarlowCondensed-Medium.ttf') format('truetype');
				font-weight: 500 700;
				font-display: swap;
			}
			@font-face {
				font-family: 'Simulator Digits';
				src: url('/digital-life/assets/fonts/Oxanium-Variable.ttf') format('truetype');
				font-weight: 200 800;
				font-display: swap;
			}
			.dl-room {
				--ink: #e6edf2;
				--muted: #b7c3cb;
				--faint: #8d9aa4;
				--line: rgba(224, 235, 243, 0.42);
				--line-strong: rgba(229, 239, 246, 0.66);
				--chip: rgba(158, 176, 190, 0.34);
				--cream: #f6ecdd;
				--red: #9a3931;
				--mono: 'Simulator Condensed', 'Bahnschrift Condensed', 'Bahnschrift', 'Microsoft YaHei UI', sans-serif;
				--digits: 'Simulator Digits', 'Bahnschrift', 'Consolas', monospace;
				--body: 'Microsoft YaHei UI', 'Microsoft YaHei', 'Segoe UI', sans-serif;
				position: relative;
				box-sizing: border-box;
				width: 100%;
				height: 100%;
				min-height: 100vh;
				overflow: hidden;
				background: #1d232a;
				color: var(--ink);
				font: 13px/1.6 var(--body);
				text-shadow: 0 1px 4px rgba(6, 10, 15, 0.8);
				isolation: isolate;
			}
			.dl-room * { box-sizing: border-box; }
			.dl-bg, .dl-bg-art, .dl-vignette { position: absolute; inset: 0; pointer-events: none; }
			.dl-bg {
				background:
					url('/digital-life/assets/background.webp') center 42% / cover no-repeat,
					radial-gradient(58% 52% at 70% 26%, rgba(255, 213, 150, 0.30), rgba(255, 200, 140, 0.06) 55%, transparent 78%),
					linear-gradient(180deg, #2f353d 0%, #262d36 52%, #1a1f26 100%);
				filter: brightness(0.72) saturate(0.95);
			}
			.dl-bg-art { width: 100%; height: 100%; opacity: 0.18; }
			.dl-bg-art path, .dl-bg-art line, .dl-bg-art rect { fill: none; stroke: rgba(203, 220, 233, 0.30); stroke-width: 1; }
			.dl-bg-art .warm { stroke: rgba(255, 214, 160, 0.34); }
			.dl-vignette {
				background:
					linear-gradient(180deg, rgba(12, 17, 23, 0.86) 0%, rgba(12, 17, 23, 0.44) 9%, transparent 22%, transparent 66%, rgba(10, 14, 19, 0.92) 100%),
					linear-gradient(90deg, rgba(8, 12, 17, 0.78) 0%, rgba(8, 12, 17, 0.4) 15%, transparent 33%, transparent 67%, rgba(8, 12, 17, 0.4) 85%, rgba(8, 12, 17, 0.78) 100%),
					radial-gradient(120% 92% at 50% 44%, transparent 34%, rgba(9, 13, 18, 0.76) 100%);
			}

			/* ---- shell ---------------------------------------------------- */
			.dl-hud {
				position: relative;
				display: grid;
				grid-template-columns: minmax(196px, 252px) minmax(0, 1fr) minmax(196px, 252px);
				grid-template-rows: auto minmax(0, 1fr) auto;
				gap: 0 22px;
				height: 100%;
				min-height: 100vh;
				padding: 18px 24px 0;
			}
			.dl-hud > .dl-topbar { grid-column: 1 / -1; }
			.dl-hud > .dl-left { grid-column: 1; align-self: start; }
			.dl-hud > .dl-stage { grid-column: 2; align-self: stretch; }
			.dl-hud > .dl-right { grid-column: 3; align-self: start; }
			.dl-hud > .dl-rail { grid-column: 1 / -1; }

			/* ---- type primitives ------------------------------------------ */
			.dl-eyebrow {
				font: 500 10px/1.2 var(--mono);
				letter-spacing: 2.4px;
				text-transform: uppercase;
				color: var(--muted);
			}
			.dl-rule { height: 1px; background: var(--line); }
			.dl-readout {
				display: inline-block;
				min-width: 62px;
				padding: 0 7px;
				background: var(--chip);
				color: #f2f7fa;
				text-align: center;
				font: 400 12px/1.7 var(--mono);
				letter-spacing: 0.6px;
			}
			.dl-readout--tight { min-width: 0; }
			.dl-barcode {
				width: 31px; height: 11px; opacity: 0.45; flex: none;
				background: repeating-linear-gradient(90deg, var(--ink) 0 1px, transparent 1px 3px);
			}

			/* ---- topbar --------------------------------------------------- */
			.dl-topbar { display: flex; align-items: flex-start; gap: 26px; padding-bottom: 12px; }
			.dl-brand { display: flex; align-items: center; gap: 14px; flex: none; }
			.dl-brand .mark { width: 26px; height: 34px; flex: none; }
			.dl-brand strong {
				display: block;
				font: 500 clamp(22px, 1.9vw, 30px) / 0.94 var(--mono);
				letter-spacing: 3px;
			}
			.dl-brand small {
				display: block;
				margin-top: 4px;
				font: 400 9px/1.2 var(--body);
				letter-spacing: 3px;
				color: var(--muted);
			}
			.dl-topdataline { display: flex; align-items: flex-start; gap: clamp(14px, 2.2vw, 40px); flex: 1; flex-wrap: wrap; }
			.dl-datum { min-width: 0; }
			.dl-datum .dl-eyebrow { display: block; margin-bottom: 3px; }
			.dl-datum .value { display: flex; align-items: baseline; gap: 8px; font: 400 12px/1.2 var(--mono); letter-spacing: 1px; }

			/* ---- columns / sections --------------------------------------- */
			.dl-left, .dl-right { display: flex; flex-direction: column; gap: 18px; padding-top: 4px; }
			/* a whisper of scrim so the HUD stays legible over the bright shelves */
			.dl-left, .dl-right { text-shadow: 0 1px 5px rgba(6, 10, 15, 0.9); }
			.dl-section { position: relative; padding-top: 9px; }
			.dl-section::before {
				content: '';
				position: absolute;
				left: -3px; top: 0;
				width: 46px; height: 7px;
				border-left: 1px solid rgba(206, 222, 233, 0.5);
				border-top: 1px solid rgba(206, 222, 233, 0.5);
			}
			.dl-section h2 {
				margin: 0 0 6px;
				font: 500 12px/1.3 var(--mono);
				letter-spacing: 1.6px;
				text-transform: uppercase;
				color: #d5dfe6;
			}
			.dl-section h2 .cn { color: var(--muted); letter-spacing: 2px; margin-left: 6px; font-weight: 400; }
			.dl-dl { margin: 0; }
			.dl-dl > div { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; margin: 6px 0; }
			.dl-dl dt { font: 400 clamp(11px, 0.86vw, 13px) / 1.3 var(--body); color: var(--muted); flex: none; }
			.dl-dl dd { margin: 0; font: 400 12px/1.3 var(--mono); letter-spacing: 0.5px; text-align: right; color: #eaf1f6; word-break: break-word; }
			.dl-meter { height: 3px; margin: 2px 0 8px; background: rgba(190, 205, 217, 0.22); position: relative; }
			.dl-meter > i { position: absolute; left: 0; top: 0; height: 100%; background: #dfe9f0; }
			.dl-note { margin: 8px 0 0; font: 11.5px/1.5 var(--body); color: #a9b5be; }

			/* ---- center stage --------------------------------------------- */
			.dl-stage { position: relative; display: flex; align-items: flex-end; justify-content: center; min-height: 380px; padding-bottom: 6px; }
			.dl-character {
				position: absolute;
				left: 50%;
				bottom: 0;
				transform: translateX(-50%);
				height: min(100%, 620px);
				width: auto;
				max-width: 100%;
				object-fit: contain;
				object-position: bottom center;
				/* the reference fades the sprite's bottom edge into the desk */
				-webkit-mask-image: linear-gradient(to bottom, #000 88%, transparent 100%);
				mask-image: linear-gradient(to bottom, #000 88%, transparent 100%);
				filter: drop-shadow(0 18px 34px rgba(8, 12, 17, 0.45));
				pointer-events: none;
				user-select: none;
			}
			.dl-character--listening { filter: drop-shadow(0 18px 34px rgba(8, 12, 17, 0.45)) saturate(1.02); }
			.dl-portrait {
				position: relative;
				width: min(300px, 60%);
				align-self: center;
				margin-bottom: 6px;
				padding: 26px 18px 30px;
				border: 1px solid var(--line);
				border-radius: 2px;
				background:
					radial-gradient(70% 60% at 50% 42%, rgba(255, 226, 186, 0.20), transparent 72%),
					linear-gradient(180deg, rgba(24, 30, 38, 0.42), rgba(18, 23, 30, 0.62));
				text-align: center;
				backdrop-filter: blur(1px);
			}
			.dl-portrait::before, .dl-portrait::after {
				content: '';
				position: absolute;
				width: 16px; height: 16px;
				border-color: var(--line-strong);
				border-style: solid;
			}
			.dl-portrait::before { left: 6px; top: 6px; border-width: 1px 0 0 1px; }
			.dl-portrait::after { right: 6px; bottom: 6px; border-width: 0 1px 1px 0; }
			.dl-portrait .initial {
				font: 500 clamp(46px, 5vw, 72px) / 1 var(--mono);
				letter-spacing: 6px;
				color: rgba(246, 236, 221, 0.92);
			}
			.dl-portrait .slot {
				display: block;
				margin-top: 12px;
				font: 400 9px/1.5 var(--mono);
				letter-spacing: 2.6px;
				color: var(--faint);
			}
			.dl-portrait .breath {
				position: absolute;
				left: 50%; top: 38%;
				width: 168px; height: 168px;
				margin: -84px 0 0 -84px;
				border-radius: 50%;
				background: radial-gradient(circle, rgba(255, 221, 176, 0.24), transparent 68%);
				animation: dl-breath 5.2s ease-in-out infinite;
				pointer-events: none;
			}
			@keyframes dl-breath {
				0%, 100% { transform: scale(0.94); opacity: 0.55; }
				50% { transform: scale(1.06); opacity: 0.95; }
			}
			.dl-caption { position: absolute; left: 0; right: 0; bottom: 4px; text-align: center; padding: 0 12px; }
			.dl-caption .line {
				display: inline-block;
				max-width: 100%;
				font: 400 clamp(13px, 1.15vw, 17px) / 1.5 var(--body);
				color: #f1e7da;
			}
			.dl-caption .sig { display: block; margin-top: 5px; font: 400 9px/1.4 var(--mono); letter-spacing: 2.8px; color: var(--faint); }
			.dl-bubble {
				position: absolute;
				left: 50%; top: 8%;
				transform: translateX(-50%);
				max-width: min(430px, 86%);
				padding: 11px 18px 13px;
				border: 1px solid rgba(222, 198, 196, 0.85);
				border-radius: 20px 22px 20px 8px;
				background: linear-gradient(135deg, #fff9ef 0%, #fcf3f5 82%, #f2ecf6 100%);
				box-shadow: 0 5px 0 rgba(120, 96, 104, 0.14), 0 10px 24px rgba(18, 24, 32, 0.35);
				color: #584a57;
				text-shadow: none;
				font: 14px/1.55 var(--body);
				animation: dl-bubble-in 0.22s ease-out;
			}
			.dl-bubble strong { display: block; font: 500 9px/1.4 var(--mono); letter-spacing: 2.4px; color: #9d7e89; text-transform: uppercase; }
			@keyframes dl-bubble-in { from { opacity: 0; transform: translate(-50%, 6px); } to { opacity: 1; transform: translate(-50%, 0); } }

			/* ---- console -------------------------------------------------- */
			.dl-console { border: 1px solid var(--line); background: rgba(14, 19, 25, 0.55); }
			.dl-console-title {
				display: flex; align-items: center; gap: 6px;
				padding: 6px 9px;
				border-bottom: 1px solid rgba(190, 206, 218, 0.28);
				font: 400 10px/1.4 var(--mono);
				letter-spacing: 1.4px;
				color: #c6d2da;
				text-transform: uppercase;
			}
			.dl-console-title .dot { width: 5px; height: 5px; border-radius: 50%; background: #8fc7a4; flex: none; }
			.dl-console-title .barcode { margin-left: auto; }
			.dl-console-body {
				margin: 0;
				padding: 7px 9px;
				height: 118px;
				overflow-y: auto;
				font: 400 10px/1.55 var(--digits);
				letter-spacing: 0.2px;
				color: #cfdae2;
				scrollbar-width: thin;
			}
			.dl-console-body .row { display: block; white-space: pre-wrap; word-break: break-word; }
			.dl-console-body .row.in { color: #e7d9c4; }
			.dl-console-body .row.out { color: #cfe4d6; }
			.dl-console-body .row.meta { color: #8d9aa4; }
			.dl-console-body .row.meta::before { content: '· '; }
			.dl-console-foot {
				display: flex; justify-content: space-between; gap: 8px;
				padding: 5px 9px;
				border-top: 1px solid rgba(190, 206, 218, 0.22);
				font: 400 9px/1.4 var(--mono);
				letter-spacing: 1.6px;
				color: var(--faint);
				text-transform: uppercase;
			}

			/* ---- buttons -------------------------------------------------- */
			.dl-line-btn {
				width: 100%;
				display: flex; align-items: center; gap: 9px;
				padding: 7px 9px;
				margin: 0 0 5px;
				border: 1px solid rgba(198, 213, 224, 0.46);
				background: rgba(150, 168, 182, 0.16);
				color: var(--ink);
				font: 400 12px/1.3 var(--body);
				letter-spacing: 1px;
				text-align: left;
				cursor: pointer;
				transition: background 0.16s, border-color 0.16s;
			}
			.dl-line-btn:hover:not(:disabled) { background: rgba(170, 188, 201, 0.30); border-color: rgba(214, 228, 238, 0.7); }
			.dl-line-btn:disabled { opacity: 0.45; cursor: default; }
			.dl-line-btn .code { font: 400 9px/1.2 var(--mono); letter-spacing: 1.4px; color: var(--faint); flex: none; }
			.dl-line-btn .cn { flex: 1; }
			.dl-line-btn .en { font: 400 9px/1.2 var(--mono); letter-spacing: 1.8px; color: var(--muted); text-transform: uppercase; }
			.dl-line-btn--primary { border-color: rgba(232, 214, 200, 0.72); background: rgba(244, 226, 191, 0.20); }
			.dl-mini {
				border: 1px solid rgba(198, 213, 224, 0.5);
				background: transparent;
				color: var(--ink);
				font: 400 11px/1.2 var(--mono);
				letter-spacing: 1.4px;
				padding: 5px 10px;
				cursor: pointer;
			}
			.dl-mini:hover:not(:disabled) { background: rgba(170, 188, 201, 0.26); }
			.dl-mini:disabled { opacity: 0.45; cursor: default; }

			/* ---- composer ------------------------------------------------- */
			.dl-composer { display: flex; gap: 8px; margin-top: 9px; }
			.dl-composer input {
				flex: 1;
				min-width: 0;
				padding: 8px 10px;
				border: 1px solid rgba(198, 213, 224, 0.5);
				background: rgba(16, 21, 28, 0.5);
				color: var(--ink);
				font: 400 12px/1.4 var(--body);
				letter-spacing: 0.4px;
			}
			.dl-composer input::placeholder { color: rgba(180, 194, 204, 0.62); }
			.dl-composer input:focus { outline: 1px solid rgba(232, 214, 200, 0.6); outline-offset: 1px; }
			.dl-composer .send {
				flex: none;
				padding: 0 16px;
				border: 1px solid rgba(240, 222, 200, 0.72);
				background: rgba(244, 226, 191, 0.26);
				color: #fdf6e8;
				font: 500 12px/1 var(--body);
				letter-spacing: 2px;
				cursor: pointer;
			}
			.dl-composer .send:disabled { opacity: 0.45; cursor: default; }

			/* ---- bottom rail ---------------------------------------------- */
			.dl-rail { padding-top: 10px; }
			.dl-rail::before { content: ''; display: block; height: 1px; background: var(--line-strong); margin-bottom: 9px; position: relative; }
			.dl-clockrow { display: flex; align-items: flex-end; gap: clamp(12px, 1.6vw, 26px); flex-wrap: wrap; }
			.dl-run {
				width: 42px; height: 46px;
				background: var(--red);
				display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 5px;
				flex: none;
				text-shadow: none;
			}
			.dl-run span { font: 500 10px/1 var(--mono); letter-spacing: 1.4px; color: #eef1f3; }
			.dl-run i { width: 55%; height: 8px; background: repeating-linear-gradient(90deg, #e9edf0 0 2px, transparent 2px 5px); opacity: 0.9; }
			.dl-timestamp .dl-eyebrow { display: block; }
			.dl-timestamp .stamp {
				display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap;
				font: 400 clamp(30px, 3.6vw, 52px) / 1 var(--digits);
				letter-spacing: 1px;
			}
			.dl-timestamp .stamp small { font: 400 clamp(14px, 1.4vw, 21px) / 1 var(--digits); letter-spacing: 1px; color: var(--muted); }
			.dl-dayratio { margin-left: auto; text-align: right; }
			.dl-dayratio .value { font: 400 13px/1.2 var(--mono); letter-spacing: 1px; }
			.dl-dayratio .barcode { margin-left: auto; margin-top: 4px; }
			.dl-daytrack { position: relative; height: 14px; margin: 7px 0 3px; background: rgba(176, 194, 208, 0.34); }
			.dl-daytrack > i { position: absolute; left: 0; top: 0; height: 100%; background: rgba(232, 242, 248, 0.55); }
			.dl-daytrack > b { position: absolute; top: -2px; width: 2px; height: calc(100% + 4px); background: #f2f8fc; }
			.dl-tracklabels { display: flex; justify-content: space-between; font: 400 9px/1 var(--mono); letter-spacing: 1.4px; color: var(--faint); padding-bottom: 8px; }

			/* ---- onboarding / errors -------------------------------------- */
			.dl-sheet {
				max-width: 380px;
				margin: 0 auto;
				padding: 20px 22px;
				border: 1px solid var(--line);
				background: rgba(14, 19, 25, 0.62);
			}
			.dl-sheet h3 { margin: 0 0 6px; font: 500 15px/1.35 var(--mono); letter-spacing: 2px; }
			.dl-sheet p { margin: 0 0 14px; font: 12px/1.6 var(--body); color: var(--muted); }
			.dl-field { margin-bottom: 10px; }
			.dl-field label { display: block; margin-bottom: 3px; font: 400 10px/1.3 var(--mono); letter-spacing: 1.8px; color: var(--faint); text-transform: uppercase; }
			.dl-field input { width: 100%; padding: 7px 9px; border: 1px solid rgba(198, 213, 224, 0.5); background: rgba(16, 21, 28, 0.5); color: var(--ink); font: 400 12px var(--body); }
			.dl-alert {
				border: 1px solid rgba(196, 138, 120, 0.6);
				background: rgba(120, 46, 38, 0.34);
				color: #f3ddd3;
				padding: 8px 11px;
				font: 400 11px/1.55 var(--body);
			}
			.dl-alert strong { display: block; font: 500 9px/1.4 var(--mono); letter-spacing: 2px; text-transform: uppercase; margin-bottom: 3px; }
			.dl-pill { display: inline-block; font: 400 10px/1.6 var(--mono); letter-spacing: 1.6px; padding: 0 6px; background: var(--chip); color: #eef4f8; }
			.dl-pill.ok { background: rgba(122, 168, 138, 0.5); }
			.dl-pill.bad { background: rgba(154, 57, 49, 0.6); }
			.dl-pill.warn { background: rgba(176, 128, 70, 0.5); }
			.dl-hidden { display: none !important; }

			/* ---- narrow: collapse to one column --------------------------- */
			@media (max-width: 1080px) {
				.dl-hud { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); grid-template-rows: auto auto auto auto; padding: 16px 16px 0; }
				.dl-hud > .dl-topbar { grid-column: 1 / -1; }
				.dl-hud > .dl-stage { grid-column: 1 / -1; order: 2; min-height: 220px; }
				.dl-hud > .dl-left { grid-column: 1; order: 3; }
				.dl-hud > .dl-right { grid-column: 2; order: 4; }
				.dl-hud > .dl-rail { order: 5; }
			}
			@media (max-width: 720px) {
				.dl-hud { grid-template-columns: minmax(0, 1fr); }
				.dl-hud > .dl-left, .dl-hud > .dl-right { grid-column: 1; }
				.dl-brand strong { font-size: 20px; letter-spacing: 2px; }
				.dl-portrait { width: min(220px, 80%); }
			}
		`

		/** Inject the stylesheet once. */
		function installStyle() {
			if (document.getElementById(STYLE_ID) !== null) return
			const style = document.createElement('style')
			style.id = STYLE_ID
			style.textContent = CSS
			document.head.appendChild(style)
		}

		/** POST one whitelisted action. */
		async function act(body) {
			const response = await fetch(ACTION_URL, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body)
			})
			const text = await response.text()
			let parsed
			try {
				parsed = JSON.parse(text)
			} catch {
				parsed = { ok: false, error: `服务端返回了非 JSON 内容（${response.status}）` }
			}
			if (!response.ok || parsed.ok === false) {
				throw new Error(parsed.error || `HTTP ${response.status}`)
			}
			return parsed
		}

		/** Zero-padded two-digit. */
		function two(value) {
			return String(value).padStart(2, '0')
		}

		function phaseLabel(phase) {
			if (phase === 'alive') return '活着 / ALIVE'
			if (phase === 'unborn') return '还没出生 / UNBORN'
			if (phase === 'blocked') return '被挡住 / BLOCKED'
			if (phase === 'broken') return '档案有问题 / BROKEN'
			return String(phase).toUpperCase()
		}

		function periodLabel(period) {
			if (period === 'awake') return '醒着 / AWAKE'
			if (period === 'quiet') return '睡着 / QUIET'
			if (period === 'late') return '该睡了 / LATE'
			return '—'
		}

		/** One `<dt>/<dd>` row. `chip` renders the value as a readout. */
		function Row({ label, value, chip, dim }) {
			return h('div', null,
				h('dt', null, label),
				h('dd', { style: dim ? { color: '#93a0aa' } : undefined },
					chip ? h('span', { className: 'dl-readout dl-readout--tight' }, value) : value)
			)
		}

		/** A titled block with the L-bracket corner from the reference HUD. */
		function Section({ title, cn, children, className }) {
			return h('section', { className: `dl-section${className ? ' ' + className : ''}` },
				h('h2', null, title, cn ? h('span', { className: 'cn' }, cn) : null),
				children)
		}

		/** Hairline progress rule. */
		function Meter({ ratio }) {
			const width = Math.max(0, Math.min(1, Number(ratio) || 0)) * 100
			return h('div', { className: 'dl-meter' }, h('i', { style: { width: `${width}%` } }))
		}

		/** A HUD line button: code, Chinese label, English rail label. */
		function LineButton({ code, cn, en, onClick, disabled, primary }) {
			return h('button', {
				type: 'button',
				className: `dl-line-btn${primary ? ' dl-line-btn--primary' : ''}`,
				onClick,
				disabled: Boolean(disabled)
			},
				h('span', { className: 'code' }, code),
				h('span', { className: 'cn' }, cn),
				h('span', { className: 'en' }, en))
		}

		/** The brand mark: a bracket built from strokes, drawn here, not borrowed. */
		function BrandMark() {
			return h('svg', { className: 'mark', viewBox: '0 0 26 34', fill: 'none', 'aria-hidden': 'true' },
				h('path', { d: 'M2 1h22v32H2z', stroke: 'rgba(226,237,244,0.55)', strokeWidth: '1' }),
				h('path', { d: 'M7 9h6M7 16h10M7 23h4', stroke: 'rgba(240,232,214,0.85)', strokeWidth: '1.4' }))
		}

		/** Character sprites, served by the host half from <package>/assets. */
		const CHARACTER_ROOT = '/digital-life/assets/character/'
/** The top rail: brand + the four datum columns. */
		function Topbar({ snapshot }) {
			const phase = snapshot?.phase ?? 'unborn'
			const quota = snapshot?.life?.quota
			const memory = snapshot?.memory
			const runtime = snapshot?.runtime
			return h('header', { className: 'dl-topbar' },
				h('div', { className: 'dl-brand' },
					h(BrandMark),
					h('div', null,
						h('strong', null, snapshot?.name || '书房'),
						h('small', null, 'DIGITAL LIFE · SIMULATOR'))),
				h('div', { className: 'dl-topdataline' },
					h('div', { className: 'dl-datum' },
						h('span', { className: 'dl-eyebrow' }, 'STATE / 状态'),
						h('span', { className: 'value' },
							h('span', { className: 'dl-readout dl-readout--tight' }, phaseLabel(phase)))),
					h('div', { className: 'dl-datum' },
						h('span', { className: 'dl-eyebrow' }, 'PROACTIVE QUOTA'),
						h('span', { className: 'value' },
							h('span', { className: 'dl-readout' }, quota ? `${quota.left}/${quota.cap}` : '—'),
							h('span', { className: 'dl-barcode' }))),
					h('div', { className: 'dl-datum' },
						h('span', { className: 'dl-eyebrow' }, 'MEMORY POOL'),
						h('span', { className: 'value' },
							h('span', { className: 'dl-readout' }, memory ? `${memory.total}` : '0'),
							h('span', { style: { color: '#93a0aa', letterSpacing: '1.6px' } }, memory?.fts === false ? 'FTS OFF' : 'FTS ON'))),
					h('div', { className: 'dl-datum' },
						h('span', { className: 'dl-eyebrow' }, 'HOST / 宿主'),
						h('span', { className: 'value' },
							h('span', { className: 'dl-readout dl-readout--tight' }, runtime?.node ?? '—'),
							h('span', { className: 'dl-barcode' }))))
			)
		}

		/** Left column: core, emotion, portrait index. */
		function LeftPanel({ snapshot }) {
			const soul = snapshot?.soul
			const clock = snapshot?.clock
			const memory = snapshot?.memory
			const runtime = snapshot?.runtime
			const manifest = snapshot?.manifest
			const birthday = clock?.birthday
			const quota = snapshot?.life?.quota
			const dayRatio = dayRatioOf(clock)

			if (!soul) {
				return h('div', { className: 'dl-left' },
					h(Section, { title: 'SYSTEM CORE', cn: '核心' },
						h('dl', { className: 'dl-dl' },
							h(Row, { label: '状态', value: phaseLabel(snapshot?.phase ?? 'unborn'), chip: true }),
							h(Row, { label: '数据根', value: runtime?.dataRoot ?? '—', dim: true }))),
					h(Section, { title: 'PORTRAIT INDEX', cn: '档案' },
						h('p', { className: 'dl-note' }, '没有人设，档案索引为空。')))
			}

			return h('div', { className: 'dl-left' },
				h(Section, { title: 'SYSTEM CORE', cn: '核心' },
					h(Meter, { ratio: memory ? Math.min(1, memory.total / 500) : 0 }),
					h('dl', { className: 'dl-dl' },
						h(Row, { label: '状态', value: phaseLabel(snapshot?.phase ?? 'alive'), chip: true }),
						h(Row, { label: '档案 rev', value: manifest?.rev ?? '—' }),
						h(Row, { label: '数据库', value: runtime?.sqlite ? 'SQLITE 3 / OK' : 'NO SQLITE' }),
						h(Row, { label: 'NODE', value: runtime?.node ?? '—' }),
						h(Row, { label: '进程 PID', value: runtime?.pid ?? '—' }),
						h(Row, { label: '待办', value: `${snapshot?.life?.pending ?? 0} 条` }))),

				h(Section, { title: 'EMOTION MAP', cn: '此刻' },
					h('dl', { className: 'dl-dl' },
						h(Row, { label: '时段', value: periodLabel(clock?.period), chip: true }),
						h(Row, { label: '日界', value: `04:00 · ${clock?.localDay ?? '—'}` }),
						h(Row, { label: '作息', value: `${clock?.sleepAt ?? '—'}–${clock?.wakeAt ?? '—'}` }),
						h(Row, { label: '主动开口', value: quota ? `${quota.left}/${quota.cap}` : '—' }),
						h(Row, { label: '当天进度', value: `${Math.round(dayRatio * 100)}%` })),
					h('p', { className: 'dl-note' }, '她这会儿没被问话，也没有心事要报。')),

				h(Section, { title: 'PORTRAIT INDEX', cn: '档案' },
					h('dl', { className: 'dl-dl' },
						h(Row, { label: '年龄', value: `${soul.age} 岁 · ${soul.grade ?? '—'}` }),
						h(Row, { label: '称呼你', value: soul.relation?.address ?? '舅舅' }),
						h(Row, { label: '生日', value: soul.birthday ? `农历 ${soul.birthday.month}-${soul.birthday.day}` : '—' }),
						h(Row, { label: '距生日', value: birthday ? `${birthday.daysUntil} 天` : '—' }),
						h(Row, { label: '记忆', value: `${memory?.total ?? 0} 条` })),
					h('p', { className: 'dl-note' },
						soul.family ? `和${soul.family.livingWith}住在一起，爸爸妈妈${soul.family.parents}。` : '家庭设定为空。')))
		}

		/** Right column: console, channels, behavior parameters. */
		function RightPanel({ snapshot, turns, error, note, busy, onSay, onPat, onFeed, onPoke, onReload }) {
			const channels = snapshot?.channels ?? []
			const phase = snapshot?.phase ?? 'unborn'
			const alive = phase === 'alive'
			const recent = turns.slice(-14)
			return h('div', { className: 'dl-right' },
				h('div', { className: 'dl-console' },
					h('div', { className: 'dl-console-title' },
						h('span', { className: 'dot' }),
						h('span', null, `${snapshot?.name || 'DIGITAL'} / RUNTIME`),
						h('span', { className: 'dl-barcode' })),
					h('pre', { className: 'dl-console-body' },
						recent.length === 0
							? h('span', { className: 'row meta' }, '暂无对话。她说的每一句都会落进 soul.db。')
							: recent.map((turn, index) => h('span', {
								key: turn.id ?? `t${index}`,
								className: `row ${turn.direction === 'out' ? 'out' : 'in'}`
							}, `${turn.direction === 'out' ? '<' : '>'} ${turn.text}`)),
						error ? h('span', { className: 'row meta', style: { color: '#e6b3a4' } }, error.replace(/\n/g, ' ')) : null,
						note ? h('span', { className: 'row meta' }, note) : null),
					h('div', { className: 'dl-console-foot' },
						h('span', null, 'LOCAL EVENT STREAM'),
						h('span', null, alive ? 'CONNECTED' : 'IDLE'))),

				h(Section, { title: 'RECOGNITION', cn: '通道' },
					h('dl', { className: 'dl-dl' },
						channels.length === 0
							? h('div', null, h('dt', null, '通道'), h('dd', null, h('span', { className: 'dl-readout dl-readout--tight' }, '—')))
							: channels.map((channel) => h('div', { key: channel.id },
									h('dt', null, String(channel.id).toUpperCase()),
									h('dd', null, h('span', {
										className: `dl-pill ${channel.state === 'bound' ? 'ok' : channel.state === 'degraded' ? 'warn' : 'bad'}`
									}, String(channel.state).toUpperCase())))))),

				h(Section, { title: 'BEHAVIOR PARAMETERS', cn: '互动' },
					alive
						? h('div', null,
								h(LineButton, { code: '01', cn: '跟她说话', en: 'SAY', onClick: onPoke, disabled: busy }),
								h(LineButton, { code: '02', cn: '摸头', en: 'PAT', onClick: onPat, disabled: busy }),
								h(LineButton, { code: '03', cn: '喂饭 · 充值', en: 'RICE', onClick: onFeed, disabled: busy, primary: true }),
								h('div', { style: { display: 'flex', gap: '6px', marginTop: '8px' } },
									h('a', {
										className: 'dl-mini',
										href: '/digital-life/export.dshlife',
										download: '',
										style: { textDecoration: 'none', textAlign: 'center', flex: 1 }
									}, '打包带走 EXPORT'),
									h('button', { className: 'dl-mini', type: 'button', onClick: onReload, style: { flex: 'none' } }, '重扫 RESCAN')))
						: h('p', { className: 'dl-note' }, '她还没出生，互动参数不可用。')),
				h('p', { className: 'dl-note' }, '这个面板只是观察窗。关掉它，她照样按作息活着。'),
				h(Composer, {
					onSend: onSay,
					disabled: !alive || busy,
					placeholder: alive ? '跟舅舅说点什么…' : '她还没出生'
				}))
		}

		/** Her idle line when there is nothing to report. */
		function idleLine(snapshot) {
			const phase = snapshot?.phase ?? 'unborn'
			if (phase === 'unborn') return '这儿还空着，等你放一个人进来。'
			if (phase === 'blocked') return snapshot?.blockedReason || '我起不来。'
			if (phase === 'broken') return '我的档案读不出来，先别动它。'
			const period = snapshot?.clock?.period
			if (period === 'quiet') return '（睡着了，呼吸很轻）'
			if (period === 'late') return '该睡了……可我有点不困。'
			return '我在这儿呢。'
		}

		/**
		 * Center stage: the character in the study, her caption, her chatter.
		 *
		 * The sprite follows what is happening: a blink every few seconds while
		 * idle, `petting` for a moment after a pat, `listening` while a turn is in
		 * flight. No WebGL mesh here — this is a still portrait with CSS fades,
		 * which is enough for an observation window.
		 */
		function Stage({ snapshot, turns, busy, patSignal }) {
			const [blinking, setBlinking] = React.useState(false)
			const [petting, setPetting] = React.useState(false)

			React.useEffect(() => {
				const id = window.setInterval(() => {
					setBlinking(true)
					window.setTimeout(() => setBlinking(false), 140)
				}, 5200)
				return () => window.clearInterval(id)
			}, [])

			React.useEffect(() => {
				if (!patSignal) return undefined
				setPetting(true)
				const id = window.setTimeout(() => setPetting(false), 1600)
				return () => window.clearTimeout(id)
			}, [patSignal])

			const last = [...turns].reverse().find((turn) => turn.direction === 'out' && typeof turn.text === 'string' && turn.text !== '')
			const phase = snapshot?.phase ?? 'unborn'
			const sprite = petting ? 'petting' : busy ? 'listening' : blinking ? 'blink' : 'idle'
			return h('div', { className: 'dl-stage' },
				phase === 'alive'
					? h('img', {
							className: `dl-character${busy ? ' dl-character--listening' : ''}`,
							src: `${CHARACTER_ROOT}${sprite}.webp`,
							alt: '',
							draggable: false
						})
					: null,
				last && phase === 'alive'
					? h('div', { className: 'dl-bubble' },
							h('strong', null, 'SPEECH / 她刚才说'), last.text)
					: null,
				h('div', { className: 'dl-caption' },
					h('span', { className: 'line' }, last && phase === 'alive' ? last.text : idleLine(snapshot)),
					h('span', { className: 'sig' }, 'DEEPSEEK · DIGITAL LIFE · 书房'))
			)
		}

		/** The bottom rail: state block, clock, day ratio, day track. */
		function BottomRail({ snapshot }) {
			const clock = snapshot?.clock
			const now = clock?.now ? new Date(clock.now) : new Date()
			const ratio = dayRatioOf(clock)
			const phase = snapshot?.phase ?? 'unborn'
			const stateText = phase === 'alive' ? (clock?.period === 'quiet' ? 'SLEEP' : 'RUN') : 'IDLE'
			return h('footer', { className: 'dl-rail' },
				h('div', { className: 'dl-clockrow' },
					h('div', { className: 'dl-run' },
						h('span', null, stateText),
						h('i', null)),
					h('div', { className: 'dl-timestamp' },
						h('span', { className: 'dl-eyebrow' }, 'SYSTEM TIME / 系统时间'),
						h('span', { className: 'stamp' },
							h('span', null, `${now.getFullYear()} / ${two(now.getMonth() + 1)} / ${two(now.getDate())}`),
							h('small', null, `${two(now.getHours())}:${two(now.getMinutes())}:${two(now.getSeconds())}`))),
					h('div', { className: 'dl-dayratio' },
						h('span', { className: 'dl-eyebrow' }, 'DAY ELAPSED RATIO'),
						h('div', { className: 'value' }, `${(ratio * 100).toFixed(2)}%`),
						h('div', { className: 'dl-barcode' }))),
				h('div', { className: 'dl-daytrack' },
					h('i', { style: { width: `${ratio * 100}%` } }),
					h('b', { style: { left: `calc(${ratio * 100}% - 1px)` } })),
				h('div', { className: 'dl-tracklabels' },
					h('span', null, '00:00'), h('span', null, '06:00'), h('span', null, '12:00'),
					h('span', null, '18:00'), h('span', null, '24:00')))
		}

		/** Fraction of the local day that has elapsed (24h clock, not the 04:00 day boundary). */
		function dayRatioOf(clock) {
			const now = clock?.now ? new Date(clock.now) : new Date()
			return ((now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds()) / 86400)
		}

		/** Creation sheet. */
		function CreateSheet({ onDone, onError }) {
			const [name, setName] = React.useState('悠悠')
			const [addresser, setAddresser] = React.useState('舅舅')
			const [busy, setBusy] = React.useState(false)
			const submit = async (event) => {
				event.preventDefault()
				setBusy(true)
				try {
					await act({ action: 'create', name, addresser })
					onDone()
				} catch (error) {
					onError(`创建失败：${String(error.message || error)}`)
				} finally {
					setBusy(false)
				}
			}
			return h('form', { className: 'dl-sheet', onSubmit: submit },
				h('h3', null, '创建她 / NEW SOUL'),
				h('p', null, '名字与称呼会写进档案，之后不覆盖。'),
				h('div', { className: 'dl-field' },
					h('label', { htmlFor: 'dl-name' }, '名字'),
					h('input', { id: 'dl-name', value: name, onChange: (event) => setName(event.target.value) })),
				h('div', { className: 'dl-field' },
					h('label', { htmlFor: 'dl-addr' }, '她叫你'),
					h('input', { id: 'dl-addr', value: addresser, onChange: (event) => setAddresser(event.target.value) })),
				h('button', { className: 'dl-line-btn dl-line-btn--primary', type: 'submit', disabled: busy },
					h('span', { className: 'code' }, '01'),
					h('span', { className: 'cn' }, busy ? '正在创建…' : '创建'),
					h('span', { className: 'en' }, 'CREATE')))
		}

		/** Import sheet. */
		function ImportSheet({ onDone, onError }) {
			const [source, setSource] = React.useState('')
			const [busy, setBusy] = React.useState(false)
			const submit = async (event) => {
				event.preventDefault()
				if (source.trim() === '') return
				setBusy(true)
				try {
					await act({ action: 'import', sourceRoot: source.trim() })
					onDone()
				} catch (error) {
					onError(`导入失败：${String(error.message || error)}`)
				} finally {
					setBusy(false)
				}
			}
			return h('form', { className: 'dl-sheet', onSubmit: submit },
				h('h3', null, '导入档案 / IMPORT'),
				h('p', null, '填一个含 portrait/ 的目录绝对路径。导入不会覆盖已有档案。'),
				h('div', { className: 'dl-field' },
					h('label', { htmlFor: 'dl-src' }, '来源目录'),
					h('input', { id: 'dl-src', value: source, placeholder: 'D:\\backup\\digital-life', onChange: (event) => setSource(event.target.value) })),
				h('button', { className: 'dl-line-btn dl-line-btn--primary', type: 'submit', disabled: busy },
					h('span', { className: 'code' }, '02'),
					h('span', { className: 'cn' }, busy ? '正在导入…' : '导入'),
					h('span', { className: 'en' }, 'IMPORT')))
		}

		/** The unborn state: two doors, in the middle of the room. */
		function UnbornStage({ onChanged, onError }) {
			const [mode, setMode] = React.useState('none')
			return h('div', { className: 'dl-stage', style: { flexDirection: 'column', justifyContent: 'center' } },
				mode === 'none'
					? h('div', { className: 'dl-sheet', style: { textAlign: 'center' } },
							h('h3', null, '这里还没有人'),
							h('p', null, '数据根里没有人设。创建一个新的，或者导入一份在别处生活过的档案。'),
							h('div', { style: { display: 'flex', gap: '8px', justifyContent: 'center' } },
								h('button', { className: 'dl-mini', type: 'button', onClick: () => setMode('create') }, '创建 CREATE'),
								h('button', { className: 'dl-mini', type: 'button', onClick: () => setMode('import') }, '导入 IMPORT')))
					: null,
				mode === 'create' ? h(CreateSheet, { onDone: onChanged, onError }) : null,
				mode === 'import' ? h(ImportSheet, { onDone: onChanged, onError }) : null)
		}

		/** The study console. */
		function StudyPanel() {
			const [snapshot, setSnapshot] = React.useState(null)
			const [turns, setTurns] = React.useState([])
			const [error, setError] = React.useState('')
			const [note, setNote] = React.useState('')
			const [busy, setBusy] = React.useState(false)
			const [ready, setReady] = React.useState(false)
			const [patSignal, setPatSignal] = React.useState(0)

			const reload = React.useCallback(async () => {
				try {
					const response = await fetch(STATE_URL, { cache: 'no-store' })
					const next = await response.json()
					setSnapshot(next)
					setError('')
					if (next.phase === 'alive') {
						const history = await fetch(`${TRANSCRIPT_URL}?limit=40`, { cache: 'no-store' })
						if (history.ok) {
							const body = await history.json()
							setTurns((Array.isArray(body.turns) ? body.turns : [])
								.filter((row) => row.direction === 'in' || row.direction === 'out')
								.map((row) => ({ id: row.id, direction: row.direction, text: row.text })))
						}
					}
				} catch (failure) {
					setError(`读不到她的状态：${String(failure.message || failure)}`)
				} finally {
					setReady(true)
				}
			}, [])

			React.useEffect(() => {
				let cancelled = false
				void reload()
				let source
				try {
					source = new EventSource(STREAM_URL)
					source.onmessage = (event) => {
						if (cancelled) return
						try {
							setSnapshot(JSON.parse(event.data))
						} catch {
							/* ignore a malformed frame; the next one wins */
						}
					}
					const push = (direction) => (event) => {
						if (cancelled) return
						try {
							const body = JSON.parse(event.data)
							setTurns((previous) => [...previous, { direction, text: body.text }])
						} catch {
							/* ignore */
						}
					}
					source.addEventListener('listening', push('in'))
					source.addEventListener('speech', (event) => {
						if (cancelled) return
						try {
							const body = JSON.parse(event.data)
							setTurns((previous) => [...previous, { direction: 'out', text: body.text, refused: body.refused === true }])
						} catch {
							/* ignore */
						}
					})
					source.addEventListener('speech-failed', (event) => {
						if (cancelled) return
						try {
							setError(`她没说话：${JSON.parse(event.data).error ?? '未知原因'}`)
						} catch {
							/* ignore */
						}
					})
					source.addEventListener('queued', (event) => {
						if (cancelled) return
						try {
							const body = JSON.parse(event.data)
							setTurns((previous) => [...previous, { direction: 'in', text: body.text }])
							setNote(`她睡着了。这条进了待办，现在 ${body.pending} 条。`)
						} catch {
							/* ignore */
						}
					})
					source.addEventListener('woke', (event) => {
						if (cancelled) return
						try {
							setNote(`她被叫醒了，一口气看完了 ${JSON.parse(event.data).pending} 条。`)
						} catch {
							/* ignore */
						}
					})
					source.addEventListener('late-night', (event) => {
						if (cancelled) return
						try {
							setNote(`她 ${JSON.parse(event.data).minutes} 分钟前就该睡了。明天少一次主动开口。`)
						} catch {
							/* ignore */
						}
					})
					source.addEventListener('fed', (event) => {
						if (cancelled) return
						try {
							const body = JSON.parse(event.data)
							setTurns((previous) => [...previous, { direction: 'out', text: body.text }])
							setNote(`舅舅充了 ${body.delta}。`)
						} catch {
							/* ignore */
						}
					})
					source.addEventListener('pat', (event) => {
						if (cancelled) return
						try {
							const body = JSON.parse(event.data)
							setNote(`摸头第 ${body.today} 次。${body.text ? '她说：' + body.text : ''}`)
						} catch {
							/* ignore */
						}
					})
				} catch {
					/* SSE unavailable: the one-shot fetch still rendered */
				}
				return () => {
					cancelled = true
					if (source) source.close()
				}
			}, [reload])

			/** One action, with the busy gate and the shared error channel. */
			const run = React.useCallback(async (work) => {
				setBusy(true)
				setNote('')
				try {
					await work()
				} catch (failure) {
					setError(String(failure.message || failure))
				} finally {
					setBusy(false)
				}
			}, [])

			const speak = React.useCallback((text) => run(async () => {
				const result = await act({ action: 'say', text })
				if (result.queued === true) setNote(result.note ?? '她睡着了，这条进了待办。')
			}), [run])

			const poke = React.useCallback(() => run(async () => {
				const result = await act({ action: 'proactive' })
				if (result.spoke !== true) setNote(result.reason ?? '她现在不想说话。')
			}), [run])

			const pat = React.useCallback(() => run(async () => {
				const result = await act({ action: 'pat' })
				setPatSignal((value) => value + 1)
				if (result.said) setNote(result.said)
				else setNote(`今天第 ${result.today} 次摸头。她还没缓过来，先不说话。`)
			}), [run])

			const feed = React.useCallback(() => run(async () => {
				const first = await act({ action: 'feed' })
				if (first.kind === 'recharged') {
					setNote(`舅舅充了 ${first.delta}，大米饭到了。`)
					return
				}
				if (first.kind === 'baseline') setNote('先记下现在的充值额，下次真充钱她就知道了。')
				const config = snapshot?.feed ?? {}
				const url = config.rechargeUrl || 'https://platform.deepseek.com/top_up'
				const tries = Number(config.pollTries ?? 24)
				const waitMs = Number(config.pollSeconds ?? 5) * 1000
				try {
					window.open(url, '_blank', 'noopener')
				} catch {
					/* popup blocked: the address bar still works */
				}
				setNote(`充值页开着了。我在盯着大米饭，${tries} 次之内到账我就告诉她。`)
				for (let i = 1; i <= tries; i += 1) {
					await new Promise((resolve) => window.setTimeout(resolve, waitMs))
					const next = await act({ action: 'feed' })
					if (next.kind === 'recharged') {
						setNote(`舅舅充了 ${next.delta}，大米饭到了。`)
						return
					}
					if (next.kind === 'unavailable') {
						setNote(next.error ?? '拿不到余额，可能需要先在 credentials/deepseek.json 里放 apiKey。')
						return
					}
				}
				setNote('等了半天没到账，先不盯了。')
			}), [run, snapshot])

			if (!ready) {
				return h('div', { className: 'dl-room' },
					h('div', { className: 'dl-bg' }),
					h('div', { className: 'dl-hud' },
						h('div', { style: { gridColumn: '1 / -1', padding: '40px 0', font: '400 11px/1.5 monospace', letterSpacing: '2px', color: '#b7c3cb' } },
							'CONNECTING / 正在看她…')))
			}

			const phase = snapshot?.phase ?? 'unborn'

			return h('div', { className: 'dl-room' },
				h('div', { className: 'dl-bg' }),
				h('div', { className: 'dl-vignette' }),
				h('div', { className: 'dl-hud' },
					h(Topbar, { snapshot }),
					h(LeftPanel, { snapshot }),
					phase === 'alive'
						? h(Stage, { snapshot, turns, busy, patSignal })
						: h(UnbornStage, { onChanged: reload, onError: setError }),
					h(RightPanel, {
						snapshot,
						turns,
						error,
						note,
						busy,
						onSay: speak,
						onPat: pat,
						onFeed: feed,
						onPoke: poke,
						onReload: reload
					}),
					phase === 'broken'
						? h('div', { className: 'dl-alert', style: { gridColumn: '1 / -1', margin: '10px 0' } },
								h('strong', null, 'ARCHIVE BROKEN'),
								'读到不认识的或不完整的数据，我停下了，没把你的档案洗成默认值。',
								h('ul', { style: { margin: '6px 0 0', paddingLeft: '18px' } },
									(snapshot?.problems || []).map((problem, index) => h('li', { key: index }, problem))))
						: null,
					h(BottomRail, { snapshot })))
		}

		/** Inline composer: kept separate so Enter-to-send stays with the input. */
		function Composer({ onSend, disabled, placeholder }) {
			const [draft, setDraft] = React.useState('')
			const send = () => {
				const text = draft.trim()
				if (text === '' || disabled) return
				setDraft('')
				onSend(text)
			}
			return h('div', { className: 'dl-composer' },
				h('input', {
					value: draft,
					placeholder,
					disabled,
					onChange: (event) => setDraft(event.target.value),
					onKeyDown: (event) => {
						if (event.key === 'Enter' && !event.shiftKey) {
							event.preventDefault()
							send()
						}
					}
				}),
				h('button', { className: 'send', type: 'button', disabled: disabled || draft.trim() === '', onClick: send }, '说'))
		}

		/** Sidebar glyph: a small lamp, drawn inline. */
		function StudyGlyph(props) {
			const size = props && props.size ? props.size : 18
			const active = Boolean(props && props.active)
			const ink = active ? '#f0dedc' : 'currentColor'
			return h('svg', {
				width: size,
				height: size,
				viewBox: '0 0 24 24',
				fill: 'none',
				stroke: ink,
				strokeWidth: 1.6,
				strokeLinecap: 'round',
				strokeLinejoin: 'round',
				'aria-hidden': 'true'
			},
				h('path', { d: 'M8 15.5h8' }),
				h('path', { d: 'M9.5 18.5h5' }),
				h('path', { d: 'M12 3.5 6 13h12Z' }),
				h('path', { d: 'M12 13v2.5' })
			)
		}

		/** @param ctx - client cordis context. */
		function apply(ctx) {
			if (React === void 0) {
				console.warn('[dsh-digital-life] React 不可用，跳过书房面板')
				return
			}
			h = React.createElement
			try {
				installStyle()
				if (typeof ctx.effect === 'function') {
					ctx.effect(() => () => {
						const style = document.getElementById(STYLE_ID)
						if (style !== null) style.remove()
					}, 'digital-life: style')
				}
				ctx.slots.inject('main', () => ctx.slots.register({
					name: 'main',
					key: 'digital-life'
				}, StudyPanel))
				ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
					name: 'sidebar.panellist',
					id: 'digital-life',
					order: 20,
					label: '书房'
				}, StudyGlyph))
			} catch (error) {
				console.warn('[dsh-digital-life] 无法注册书房面板', error)
			}
		}

		exports.apply = apply
		exports.inject = ['slots']
		return exports
	}
})
