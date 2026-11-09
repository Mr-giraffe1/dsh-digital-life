/**
 * Client half of dsh-digital-life — the study console.
 *
 * A window onto a process that keeps running when this panel is closed. It reads
 * one snapshot route and posts a small set of whitelisted actions; it never owns
 * her state. Replies arrive as finished sentences over SSE, never as token
 * deltas: the voice guard runs on the whole reply before anything is shown.
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

		/** Warm study palette. No asset borrowed from any wallpaper project. */
		const C = {
			page: '#f4ece0',
			card: '#fffaf3',
			cardEdge: '#e6d8c3',
			ink: '#3a2f26',
			inkSoft: '#7d6a58',
			inkFaint: '#a9998a',
			accent: '#b8763f',
			accentSoft: '#e8c9a0',
			her: '#fff3e2',
			warn: '#b0623c',
			shadow: '0 1px 2px rgba(90,66,44,0.06), 0 8px 24px rgba(90,66,44,0.08)'
		}

		const S = {
			root: {
				boxSizing: 'border-box',
				width: '100%',
				minHeight: '100%',
				background: C.page,
				color: C.ink,
				overflow: 'auto',
				font: '14px/1.65 "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif'
			},
			wrap: { maxWidth: '760px', margin: '0 auto', padding: '28px 24px 64px' },
			header: { display: 'flex', alignItems: 'baseline', gap: '12px', marginBottom: '4px' },
			title: {
				font: '600 26px/1.3 "Iowan Old Style", "Songti SC", Georgia, serif',
				letterSpacing: '0.5px',
				margin: 0
			},
			subtitle: { color: C.inkSoft, fontSize: '13px', margin: '2px 0 24px' },
			card: {
				background: C.card,
				border: `1px solid ${C.cardEdge}`,
				borderRadius: '14px',
				padding: '20px 22px',
				boxShadow: C.shadow,
				marginBottom: '16px'
			},
			cardTitle: {
				font: '600 15px/1.4 "Iowan Old Style", "Songti SC", Georgia, serif',
				margin: '0 0 12px',
				color: C.ink
			},
			row: { display: 'flex', gap: '20px', flexWrap: 'wrap', margin: '0 0 6px' },
			field: { minWidth: '130px' },
			label: { display: 'block', fontSize: '12px', color: C.inkFaint, marginBottom: '2px' },
			value: { fontSize: '14px', color: C.ink, wordBreak: 'break-word' },
			mono: { fontFamily: 'ui-monospace, "Cascadia Mono", Consolas, monospace', fontSize: '12px' },
			pill: {
				display: 'inline-block',
				padding: '1px 9px',
				borderRadius: '999px',
				fontSize: '12px',
				border: `1px solid ${C.cardEdge}`,
				background: '#fdf6ea',
				color: C.inkSoft
			},
			quote: {
				borderLeft: `3px solid ${C.accentSoft}`,
				padding: '2px 0 2px 12px',
				color: C.inkSoft,
				font: '13px/1.7 "Songti SC", Georgia, serif',
				margin: '10px 0 0'
			},
			button: {
				font: 'inherit',
				fontSize: '13px',
				padding: '7px 16px',
				borderRadius: '9px',
				cursor: 'pointer',
				border: `1px solid ${C.cardEdge}`,
				background: '#fff',
				color: C.ink,
				marginRight: '8px'
			},
			buttonPrimary: {
				background: C.accent,
				borderColor: C.accent,
				color: '#fffbf5',
				fontWeight: 600
			},
			input: {
				boxSizing: 'border-box',
				width: '100%',
				font: 'inherit',
				fontSize: '13px',
				padding: '8px 10px',
				borderRadius: '9px',
				border: `1px solid ${C.cardEdge}`,
				background: '#fff',
				color: C.ink,
				marginTop: '4px'
			},
			error: { color: C.warn, fontSize: '13px', marginTop: '10px' },
			notice: {
				fontSize: '13px',
				color: C.inkSoft,
				background: '#fdf6ea',
				border: `1px solid ${C.cardEdge}`,
				borderRadius: '10px',
				padding: '10px 12px',
				marginTop: '12px'
			},
			thread: {
				display: 'flex',
				flexDirection: 'column',
				gap: '8px',
				maxHeight: '320px',
				overflowY: 'auto',
				padding: '4px 2px 8px'
			},
			bubbleHer: {
				alignSelf: 'flex-start',
				maxWidth: '78%',
				background: C.her,
				border: `1px solid ${C.cardEdge}`,
				borderRadius: '14px 14px 14px 4px',
				padding: '8px 12px',
				font: '14px/1.6 "Songti SC", Georgia, serif',
				whiteSpace: 'pre-wrap'
			},
			bubbleMe: {
				alignSelf: 'flex-end',
				maxWidth: '78%',
				background: '#efe4d3',
				border: `1px solid ${C.cardEdge}`,
				borderRadius: '14px 14px 4px 14px',
				padding: '8px 12px',
				whiteSpace: 'pre-wrap'
			},
			stamp: { fontSize: '11px', color: C.inkFaint, marginTop: '2px' },
			composer: { display: 'flex', gap: '8px', alignItems: 'flex-end', marginTop: '12px' },
			empty: { fontSize: '13px', color: C.inkFaint, padding: '12px 0' }
		}

		/** Inline style for one labelled fact. */
		function Fact({ label, value, mono }) {
			return h('div', { style: S.field },
				h('span', { style: S.label }, label),
				h('span', { style: { ...S.value, ...(mono ? S.mono : null) } }, value === undefined || value === null ? '—' : String(value))
			)
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

		/** The creation form: a plain sheet, not an interview. */
		function CreateCard({ onDone, onError }) {
			const [name, setName] = React.useState('悠悠')
			const [addresser, setAddresser] = React.useState('舅舅')
			const [busy, setBusy] = React.useState(false)
			const submit = async () => {
				setBusy(true)
				try {
					await act({ action: 'create', name, addresser })
					onDone()
				} catch (error) {
					onError(String(error.message || error))
				} finally {
					setBusy(false)
				}
			}
			return h('div', { style: S.card },
				h('div', { style: S.cardTitle }, '创建一个她'),
				h('div', null,
					h('span', { style: S.label }, '名字'),
					h('input', {
						style: S.input,
						value: name,
						onChange: (event) => setName(event.target.value),
						placeholder: '悠悠'
					})
				),
				h('div', { style: { marginTop: '12px' } },
					h('span', { style: S.label }, '她怎么称呼你'),
					h('input', {
						style: S.input,
						value: addresser,
						onChange: (event) => setAddresser(event.target.value),
						placeholder: '舅舅'
					})
				),
				h('p', { style: { ...S.label, marginTop: '14px', marginBottom: 0 } },
					'缺的部分会用默认值补齐：7 岁一年级、农历九月廿八生日、喜欢画画跳舞、小朋友语气。之后可以直接改 portrait/ 里的文件。'),
				h('div', { style: { marginTop: '16px' } },
					h('button', {
						style: { ...S.button, ...S.buttonPrimary, opacity: busy ? 0.6 : 1 },
						disabled: busy,
						onClick: submit
					}, busy ? '正在出生…' : '让她出生')
				)
			)
		}

		/** Import a portrait directory or a `.dshlife` archive from this machine. */
		function ImportCard({ onDone, onError }) {
			const [sourceRoot, setSourceRoot] = React.useState('')
			const [busy, setBusy] = React.useState(false)
			const submit = async () => {
				setBusy(true)
				try {
					const target = sourceRoot.trim()
					const result = target.toLowerCase().endsWith('.dshlife')
						? await act({ action: 'import-archive', file: target })
						: await act({ action: 'import', sourceRoot: target })
					onDone(result)
				} catch (error) {
					onError(String(error.message || error))
				} finally {
					setBusy(false)
				}
			}
			return h('div', { style: S.card },
				h('div', { style: S.cardTitle }, '导入一份已有的她'),
				h('span', { style: S.label }, '对方数据根的绝对路径，或者一个 .dshlife 归档的绝对路径'),
				h('input', {
					style: S.input,
					value: sourceRoot,
					onChange: (event) => setSourceRoot(event.target.value),
					placeholder: 'D:\\backup\\悠悠.dshlife'
				}),
				h('p', { style: { ...S.label, marginTop: '10px', marginBottom: 0 } },
					'导入不会覆盖已有档案。凭据永远不在包里，导入后各通道是失联态，需要重新绑定。'),
				h('div', { style: { marginTop: '16px' } },
					h('button', {
						style: { ...S.button, ...S.buttonPrimary, opacity: busy ? 0.6 : 1 },
						disabled: busy || sourceRoot.trim() === '',
						onClick: submit
					}, busy ? '正在导入…' : '导入')
				)
			)
		}

		/** One line of the conversation. */
		function Bubble({ turn }) {
			const mine = turn.direction !== 'out'
			const note = turn.refused ? '（她没听懂，岔开了）' : turn.pending ? '（在想…）' : ''
			return h('div', { style: { display: 'flex', flexDirection: 'column', alignItems: mine ? 'flex-end' : 'flex-start' } },
				h('div', { style: mine ? S.bubbleMe : S.bubbleHer }, turn.text === '' ? '…' : turn.text),
				note === ''
					? null
					: h('span', { style: S.stamp }, note)
			)
		}

		/** The conversation: her side of the desk. */
		function TalkCard({ snapshot, turns, onTurns, onError, onNote }) {
			const [draft, setDraft] = React.useState('')
			const [busy, setBusy] = React.useState(false)
			const threadRef = React.useRef(null)
			const address = snapshot?.soul?.relation?.address || '舅舅'
			const quota = snapshot?.life?.quota
			const pending = snapshot?.life?.pending

			React.useEffect(() => {
				const node = threadRef.current
				if (node) node.scrollTop = node.scrollHeight
			}, [turns.length])

			const send = async () => {
				const text = draft.trim()
				if (text === '' || busy) return
				setBusy(true)
				setDraft('')
				if (onNote) onNote('')
				try {
					const result = await act({ action: 'say', text })
					if (result.ok !== true) {
						onError(`她没说话：${result.error ?? '未知原因'}`)
					} else if (result.queued === true) {
						onNote(result.note ?? '她睡着了，这条进了待办。')
					}
				} catch (error) {
					onError(`她没说话：${String(error.message || error)}`)
				} finally {
					setBusy(false)
				}
			}

			/**
			 * 喂饭: open the top-up page, then watch for the money to land.
			 * The cumulative recharge counter only moves when he actually pays,
			 * so polling it is safe — spending never looks like a top-up.
			 */
			const feed = async () => {
				setBusy(true)
				if (onNote) onNote('')
				try {
					const first = await act({ action: 'feed' })
					if (first.kind === 'recharged') {
						onNote(`舅舅充了 ${first.delta}，大米饭到了。`)
						return
					}
					if (first.kind === 'baseline') {
						onNote('先记下现在的充值额，下次真充钱她就知道了。')
					}
					const config = snapshot?.feed ?? {}
					const url = config.rechargeUrl || 'https://platform.deepseek.com/top_up'
					const tries = Number(config.pollTries ?? 24)
					const waitMs = Number(config.pollSeconds ?? 5) * 1000
					try {
						window.open(url, '_blank', 'noopener')
					} catch {
						/* popup blocked: the address bar still works */
					}
					onNote(`充值页开着了。我在盯着大米饭，${tries} 次之内到账我就告诉她。`)
					for (let i = 1; i <= tries; i += 1) {
						await new Promise((resolve) => window.setTimeout(resolve, waitMs))
						const next = await act({ action: 'feed' })
						if (next.kind === 'recharged') {
							onNote(`舅舅充了 ${next.delta}，大米饭到了。`)
							return
						}
						if (next.kind === 'unavailable') {
							onNote(next.error ?? '拿不到余额，可能需要先在 credentials/deepseek.json 里放 apiKey。')
							return
						}
					}
					onNote('等了半天没到账，先不盯了。')
				} catch (error) {
					onNote(`喂饭失败：${String(error.message || error)}`)
				} finally {
					setBusy(false)
				}
			}

			const onKeyDown = (event) => {
				if (event.key === 'Enter' && !event.shiftKey) {
					event.preventDefault()
					void send()
				}
			}

			/** Ask her to speak first. The gates still decide; this only opens the door. */
			const poke = async () => {
				setBusy(true)
				if (onNote) onNote('')
				try {
					const result = await act({ action: 'proactive' })
					if (result.ok !== true) onNote(result.error ?? '她现在说不了话。')
					else if (result.spoke !== true) onNote(result.reason ?? '她现在不想说话。')
				} catch (error) {
					onNote(`叫不动她：${String(error.message || error)}`)
				} finally {
					setBusy(false)
				}
			}

			/**
			 * 摸头: a somatic event in her memory. The line is throttled by the
			 * interop spec's cooldown, the memory is not — she remembers every time.
			 */
			const pat = async () => {
				setBusy(true)
				if (onNote) onNote('')
				try {
					const result = await act({ action: 'pat' })
					if (result.ok !== true) onNote(result.error ?? '她躲开了。')
					else if (result.said) onNote(result.said)
					else onNote(`今天第 ${result.today} 次摸头。她还没缓过来，先不说话。`)
				} catch (error) {
					onNote(`摸不到她：${String(error.message || error)}`)
				} finally {
					setBusy(false)
				}
			}

			const quotaText = quota === undefined || quota === null
				? ''
				: `今天还能主动找你 ${quota.left}/${quota.cap} 次`
			return h('div', { style: S.card },
				h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '10px', flexWrap: 'wrap', marginBottom: '12px' } },
					h('div', { style: { ...S.cardTitle, margin: 0 } }, '跟她说话'),
					quotaText === '' ? null : h('span', { style: S.pill }, quotaText),
					pending > 0 ? h('span', { style: S.pill }, `待办 ${pending} 条`) : null,
					h('button', {
						style: { ...S.button, marginLeft: 'auto', marginRight: '4px', fontSize: '12px', padding: '4px 10px' },
						disabled: busy,
						onClick: () => void poke()
					}, '让她说'),
					h('button', {
						style: { ...S.button, marginRight: '4px', fontSize: '12px', padding: '4px 10px' },
						disabled: busy,
						onClick: () => void pat()
					}, '摸头'),
					h('button', {
						style: { ...S.button, marginRight: 0, fontSize: '12px', padding: '4px 10px' },
						disabled: busy,
						onClick: () => void feed()
					}, '喂饭')
				),
				turns.length === 0
					? h('div', { style: S.empty }, '还没说过话。她记得的每一句都会存进 soul.db。')
					: h('div', { ref: threadRef, style: S.thread },
							turns.map((turn, index) => h(Bubble, { key: turn.id ?? `t${index}`, turn }))),
				h('div', { style: S.composer },
					h('input', {
						style: { ...S.input, marginTop: 0, flex: '1 1 auto' },
						value: draft,
						placeholder: `跟${address}说点什么…`,
						onChange: (event) => setDraft(event.target.value),
						onKeyDown
					}),
					h('button', {
						style: { ...S.button, ...S.buttonPrimary, marginRight: 0, opacity: busy || draft.trim() === '' ? 0.55 : 1 },
						disabled: busy || draft.trim() === '',
						onClick: () => void send()
					}, busy ? '…' : '说')
				),
				busy
					? h('p', { style: { ...S.label, marginTop: '8px', marginBottom: 0 } }, '她在想说清楚…')
					: null
			)
		}

		/** The born state: who she is, and the facts that prove the process is alive. */
		function AliveCard({ snapshot }) {
			const soul = snapshot.soul || {}
			const runtime = snapshot.runtime || {}
			const clock = snapshot.clock || {}
			const relation = soul.relation || {}
			const birthday = soul.birthday || {}
			const memory = snapshot.memory
			return h('div', { style: S.card },
				h('div', { style: S.cardTitle }, `${soul.name || '她'} 在这儿`),
				h('div', { style: S.row },
					h(Fact, { label: '年龄', value: `${soul.age} 岁 · ${soul.grade || ''}` }),
					h(Fact, { label: '称呼你', value: relation.address }),
					h(Fact, { label: '生日', value: `农历 ${birthday.month}-${birthday.day}` }),
					h(Fact, { label: '现在', value: periodLabel(clock.period) })
				),
				h('div', { style: S.row },
					h(Fact, { label: '喜欢', value: (soul.likes || []).join('、') }),
					h(Fact, { label: '怕', value: (soul.fears || []).join('、') }),
					h(Fact, { label: '记忆', value: memory ? `${memory.total} 条` : '—' }),
					h(Fact, { label: '主动开口', value: snapshot.life ? `${snapshot.life.quota.left}/${snapshot.life.quota.cap}` : '—' }),
					h(Fact, { label: '待办', value: snapshot.life ? `${snapshot.life.pending} 条` : '—' })
				),
				soul.family
					? h('p', { style: S.quote }, `和${soul.family.livingWith}住在一起，爸爸妈妈${soul.family.parents}。`)
					: null,
				h('div', { style: S.row, marginTop: '12px' },
					h(Fact, { label: '进程', value: `pid ${runtime.pid}`, mono: true }),
					h(Fact, { label: 'Node', value: runtime.node, mono: true }),
					h(Fact, { label: 'SQLite', value: runtime.sqlite ? '可用' : '不可用' }),
					h(Fact, { label: '档案 rev', value: snapshot.manifest?.rev })
				),
				snapshot.lastTurn
					? h('p', { style: { ...S.label, marginTop: '10px', marginBottom: 0 } },
							`上一轮：${snapshot.lastTurn.provider}/${snapshot.lastTurn.model} · ${snapshot.lastTurn.ms}ms · 召回 ${snapshot.lastTurn.recalled.length} 条`)
					: null,
				h('div', { style: { marginTop: '14px' } },
					h('a', {
						href: '/digital-life/export.dshlife',
						download: '',
						style: { ...S.button, display: 'inline-block', textDecoration: 'none', marginRight: '8px' }
					}, '把她打包带走'),
					h('span', { style: { ...S.label, marginTop: 0 } }, '人设 + 记忆，不含凭据')
				),
				h('p', { style: { ...S.label, marginTop: '10px', marginBottom: 0 } },
					'这个面板只是观察窗。把它关掉，她照样按作息活着。')
			)
		}

		/** The unborn state: two doors, nothing else. */
		function UnbornCard({ onChanged, onError }) {
			const [mode, setMode] = React.useState('none')
			return h('div', null,
				h('div', { style: S.card },
					h('div', { style: S.cardTitle }, '这里还没有人'),
					h('p', { style: { margin: '0 0 16px', color: C.inkSoft } },
						'数据根里没有找到人设。创建一个新的，或者导入一份已经在别处生活过的档案。'),
					h('button', { style: { ...S.button, ...S.buttonPrimary }, onClick: () => setMode('create') }, '创建'),
					h('button', { style: S.button, onClick: () => setMode('import') }, '导入')
				),
				mode === 'create' ? h(CreateCard, { onDone: onChanged, onError }) : null,
				mode === 'import' ? h(ImportCard, { onDone: onChanged, onError }) : null
			)
		}

		/** Human label for a period. */
		function periodLabel(period) {
			if (period === 'awake') return '醒着'
			if (period === 'quiet') return '睡着（安静时段）'
			if (period === 'late') return '该睡了'
			return '—'
		}

		/** The study console. */
		function StudyPanel() {
			const [snapshot, setSnapshot] = React.useState(null)
			const [turns, setTurns] = React.useState([])
			const [error, setError] = React.useState('')
			const [note, setNote] = React.useState('')
			const [loading, setLoading] = React.useState(true)

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
					setLoading(false)
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
					source.addEventListener('listening', (event) => {
						if (cancelled) return
						try {
							const body = JSON.parse(event.data)
							setTurns((previous) => {
								const last = previous[previous.length - 1]
								if (last && last.direction === 'in' && last.text === body.text) return previous
								return [...previous, { direction: 'in', text: body.text }]
							})
						} catch {
							/* ignore */
						}
					})
					source.addEventListener('speech', (event) => {
						if (cancelled) return
						try {
							const body = JSON.parse(event.data)
							setTurns((previous) => [...previous, {
								direction: 'out',
								text: body.text,
								refused: body.refused === true
							}])
						} catch {
							/* ignore */
						}
					})
					source.addEventListener('speech-failed', (event) => {
						if (cancelled) return
						try {
							const body = JSON.parse(event.data)
							setError(`她没说话：${body.error ?? '未知原因'}`)
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
							const body = JSON.parse(event.data)
							setNote(`她被叫醒了，一口气看完了 ${body.pending} 条。`)
						} catch {
							/* ignore */
						}
					})
					source.addEventListener('late-night', (event) => {
						if (cancelled) return
						try {
							const body = JSON.parse(event.data)
							setNote(`她 ${body.minutes} 分钟前就该睡了。明天少一次主动开口。`)
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
				} catch {
					/* SSE unavailable: the one-shot fetch still rendered */
				}
				return () => {
					cancelled = true
					if (source) source.close()
				}
			}, [reload])

			if (loading) {
				return h('div', { style: S.root }, h('div', { style: S.wrap },
					h('p', { style: S.subtitle }, '正在看她…')))
			}

			const phase = snapshot?.phase ?? 'unborn'

			return h('div', { style: S.root },
				h('div', { style: S.wrap },
					h('div', { style: S.header },
						h('h1', { style: S.title }, snapshot?.name || '书房'),
						h('span', { style: S.pill }, phaseLabel(phase))
					),
					h('p', { style: S.subtitle }, '暖光书房 · 观察窗'),

					error !== '' ? h('div', { style: S.card }, h('div', { style: S.error }, error)) : null,

					note !== ''
						? h('div', { style: S.notice }, note)
						: null,

					phase === 'blocked'
						? h('div', { style: S.card },
								h('div', { style: S.cardTitle }, '她没起来'),
								h('p', { style: { margin: 0, color: C.warn } }, snapshot?.blockedReason || '实例锁被占用'))
						: null,

					phase === 'broken'
						? h('div', { style: S.card },
								h('div', { style: S.cardTitle }, '档案有问题，我没有动它'),
								h('p', { style: { margin: '0 0 8px', color: C.inkSoft } },
									'读到不认识的或不完整的数据时，宁可停下也不要把你的数据洗成默认值。'),
								h('ul', { style: { margin: 0, paddingLeft: '20px', color: C.warn } },
									(snapshot?.problems || []).map((problem, index) => h('li', { key: index }, problem))))
						: null,

					phase === 'unborn' ? h(UnbornCard, { onChanged: reload, onError: setError }) : null,

					phase === 'alive' ? h(AliveCard, { snapshot }) : null,

					phase === 'alive'
						? h(TalkCard, {
								snapshot,
								turns,
								onTurns: setTurns,
								onError: setError,
								onNote: setNote
							})
						: null,

					snapshot?.runtime
						? h('p', { style: { ...S.label, marginTop: '18px' } },
								`数据根 ${snapshot.runtime.dataRoot}`)
						: null
				)
			)
		}

		/** Phase label for the header pill. */
		function phaseLabel(phase) {
			if (phase === 'alive') return '活着'
			if (phase === 'unborn') return '还没出生'
			if (phase === 'blocked') return '被挡住'
			if (phase === 'broken') return '档案有问题'
			return phase
		}

		/** Sidebar glyph: a small lamp, drawn inline. */
		function StudyGlyph(props) {
			const size = props && props.size ? props.size : 18
			const active = Boolean(props && props.active)
			const ink = active ? '#b8763f' : 'currentColor'
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

		/** Inject the stylesheet once. */
		function installStyle() {
			if (document.getElementById(STYLE_ID) !== null) return
			const style = document.createElement('style')
			style.id = STYLE_ID
			style.textContent = `
				[data-dsh-digital-life] button:hover:not(:disabled) { filter: brightness(0.98); }
				[data-dsh-digital-life] input:focus { outline: 2px solid rgba(184,118,63,0.28); outline-offset: 1px; }
			`
			document.head.appendChild(style)
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
