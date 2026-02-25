import { type EditorView } from '@codemirror/view';
import { App, ButtonComponent, Editor, MarkdownView, Notice, Plugin, PluginSettingTab, Setting, setIcon } from 'obsidian';
import { clearMutableTail, setMutableTail, whisperLocalMutableTailExtension } from './mutable-tail-widget';
import { DEFAULT_SETTINGS, normalizeSettings, type WhisperLocalPluginSettings } from './settings';
import { selectMostCompleteHypothesis, splitStableMutableTranscript, takeWordsRange } from './transcript-normalization';
import { runWhisperCppDiagnostics, type WhisperCppDiagnosticsReport } from './whispercpp-diagnostics';
import { WhisperCppDictationSession, type WhisperCppTranscriptUpdate } from './whispercpp-dictation';

interface DebugEventEntry {
	timestamp: string;
	message: string;
	data?: unknown;
}

interface DictationRenderState {
	editor: Editor;
	editorView: EditorView | null;
	insertionOffset: number;
	activeSequenceId: number | null;
	sequenceHypotheses: string[];
	sequenceStableWordCount: number;
}

class WhisperLocalSettingTab extends PluginSettingTab {
	private readonly plugin: WhisperLocalPlugin;

	constructor(app: App, plugin: WhisperLocalPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName('Connection')
			.setHeading();

		new Setting(containerEl)
			.setName('Base URL')
			.setDesc('Address of your local whisper.cpp server.')
			.addText((text) => text
				.setPlaceholder(DEFAULT_SETTINGS.baseUrl)
				.setValue(this.plugin.settings.baseUrl)
				.onChange(async (value) => {
					this.plugin.settings.baseUrl = value.trim() || DEFAULT_SETTINGS.baseUrl;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Language hint')
			.setDesc('Optional language for transcription (for example: en). Leave blank to auto-detect.')
			.addText((text) => text
				.setPlaceholder('Optional, for example: en')
				.setValue(this.plugin.settings.language)
				.onChange(async (value) => {
					this.plugin.settings.language = value.trim();
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Request timeout (ms)')
			.setDesc('Timeout for each whisper.cpp transcription request.')
			.addText((text) => text
				.setPlaceholder(String(DEFAULT_SETTINGS.requestTimeoutMs))
				.setValue(String(this.plugin.settings.requestTimeoutMs))
				.onChange(async (value) => {
					const parsed = Number.parseInt(value.trim(), 10);
					this.plugin.settings.requestTimeoutMs = Number.isFinite(parsed)
						? parsed
						: DEFAULT_SETTINGS.requestTimeoutMs;
						await this.plugin.saveSettings();
					}));

		new Setting(containerEl)
			.setName('Realtime tuning')
			.setHeading();

		new Setting(containerEl)
			.setName('Partial update interval (ms)')
			.setDesc('How often to request provisional transcript updates while speaking. Lower is faster but noisier.')
			.addText((text) => text
				.setPlaceholder(String(DEFAULT_SETTINGS.partialRequestIntervalMs))
				.setValue(String(this.plugin.settings.partialRequestIntervalMs))
				.onChange(async (value) => {
					const parsed = Number.parseInt(value.trim(), 10);
					this.plugin.settings.partialRequestIntervalMs = Number.isFinite(parsed)
						? parsed
						: DEFAULT_SETTINGS.partialRequestIntervalMs;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Partial minimum voiced audio (ms)')
			.setDesc('Minimum voiced audio before partial hypothesis requests begin.')
			.addText((text) => text
				.setPlaceholder(String(DEFAULT_SETTINGS.partialMinVoicedMs))
				.setValue(String(this.plugin.settings.partialMinVoicedMs))
				.onChange(async (value) => {
					const parsed = Number.parseInt(value.trim(), 10);
					this.plugin.settings.partialMinVoicedMs = Number.isFinite(parsed)
						? parsed
						: DEFAULT_SETTINGS.partialMinVoicedMs;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Stabilization agreement window')
			.setDesc('Number of consecutive hypotheses that must agree before words are committed.')
			.addText((text) => text
				.setPlaceholder(String(DEFAULT_SETTINGS.stabilizationAgreementWindow))
				.setValue(String(this.plugin.settings.stabilizationAgreementWindow))
				.onChange(async (value) => {
					const parsed = Number.parseInt(value.trim(), 10);
					this.plugin.settings.stabilizationAgreementWindow = Number.isFinite(parsed)
						? parsed
						: DEFAULT_SETTINGS.stabilizationAgreementWindow;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Mutable tail opacity')
			.setDesc('Opacity for provisional (not-yet-committed) transcript text, from 0.15 to 1.0.')
			.addText((text) => text
				.setPlaceholder(String(DEFAULT_SETTINGS.mutableTailOpacity))
				.setValue(this.plugin.settings.mutableTailOpacity.toString())
				.onChange(async (value) => {
					const parsed = Number.parseFloat(value.trim());
					this.plugin.settings.mutableTailOpacity = Number.isFinite(parsed)
						? parsed
						: DEFAULT_SETTINGS.mutableTailOpacity;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Debug logging')
			.setDesc('Write detailed live dictation traces to the developer console.')
			.addToggle((toggle) => toggle
				.setValue(this.plugin.settings.enableDebugLogging)
				.onChange(async (value) => {
					this.plugin.settings.enableDebugLogging = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Diagnostics')
			.setHeading();

		new Setting(containerEl)
			.setName('Run whisper.cpp checks')
			.setDesc('Verify health, props endpoint, inference dry run, and browser capabilities.')
			.addButton((button) => button
				.setButtonText('Run checks')
				.onClick(() => {
					void this.plugin.runWhisperCppDiagnostics(button);
				}));
	}
}

export default class WhisperLocalPlugin extends Plugin {
	settings: WhisperLocalPluginSettings = { ...DEFAULT_SETTINGS };
	private dictationSession: WhisperCppDictationSession | null = null;
	private dictationRenderState: DictationRenderState | null = null;
	private ribbonToggleEl: HTMLElement | null = null;
	private readonly debugEvents: DebugEventEntry[] = [];
	private readonly maxDebugEvents = 200;
	private diagnosticsRunning = false;
	private lastDiagnosticsReport: WhisperCppDiagnosticsReport | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.applyMutableTailAppearance();
		this.registerEditorExtension(whisperLocalMutableTailExtension);
		this.logDebug('Plugin loaded.', {
			version: this.manifest.version,
			baseUrl: this.settings.baseUrl,
			language: this.settings.language || null,
			requestTimeoutMs: this.settings.requestTimeoutMs,
			partialRequestIntervalMs: this.settings.partialRequestIntervalMs,
			partialMinVoicedMs: this.settings.partialMinVoicedMs,
			stabilizationAgreementWindow: this.settings.stabilizationAgreementWindow,
			mutableTailOpacity: this.settings.mutableTailOpacity,
		});

		this.addCommand({
			id: 'show-whisper-local-connection',
			name: 'Show connection details',
			callback: () => {
				new Notice(`Whisper local: ${this.settings.baseUrl}`);
			},
		});

		this.addCommand({
			id: 'print-live-dictation-debug-snapshot',
			name: 'Print live dictation debug snapshot',
			callback: () => {
				this.printDebugSnapshot();
			},
		});

		this.addCommand({
			id: 'run-whisper-local-diagnostics',
			name: 'Run diagnostics',
			callback: () => {
				void this.runWhisperCppDiagnostics();
			},
		});

		this.addCommand({
			id: 'start-live-dictation',
			name: 'Start live dictation',
			callback: () => {
				void this.startLiveDictation();
			},
		});

		this.addCommand({
			id: 'stop-live-dictation',
			name: 'Stop live dictation',
			callback: () => {
				void this.stopLiveDictation(true);
			},
		});

		this.ribbonToggleEl = this.addRibbonIcon('mic', 'Start live dictation', () => {
			void this.toggleLiveDictationFromRibbon();
		});
		this.updateRibbonToggleState();

		this.addSettingTab(new WhisperLocalSettingTab(this.app, this));
	}

	onunload(): void {
		this.logDebug('Plugin unloading.');
		this.resetDictationRenderState();
		document.body.style.removeProperty('--whisper-local-mutable-tail-opacity');
		void this.stopLiveDictation(false);
	}

	async loadSettings(): Promise<void> {
		const loaded = await this.loadData() as unknown;
		this.settings = normalizeSettings(loaded);
	}

	async saveSettings(): Promise<void> {
		this.settings = normalizeSettings(this.settings);
		await this.saveData(this.settings);
		this.applyMutableTailAppearance();
	}

	async runWhisperCppDiagnostics(button?: ButtonComponent): Promise<void> {
		if (this.diagnosticsRunning) {
			new Notice('Whisper.cpp diagnostics are already running.');
			return;
		}

		this.diagnosticsRunning = true;
		if (button) {
			button.setDisabled(true);
			button.setButtonText('Running...');
		}

		this.logDebug('Starting whisper.cpp diagnostics.');
		try {
			const report = await runWhisperCppDiagnostics({
				baseUrl: this.settings.baseUrl,
				language: this.settings.language,
				timeoutMs: this.settings.requestTimeoutMs,
			});
			this.lastDiagnosticsReport = report;
			this.logDebug('whisper.cpp diagnostics completed.', report.summary);
			this.logDiagnosticsToConsole(report);

			const summaryText = `${report.summary.passed} passed, ${report.summary.warned} warnings, ${report.summary.failed} failed`;
			const noticeMessage = report.summary.failed > 0
				? `whisper.cpp checks found issues: ${summaryText}`
				: `whisper.cpp checks complete: ${summaryText}`;
			new Notice(noticeMessage, 9_000);
		} catch (error) {
			console.error('[Whisper Local] Diagnostics failed to complete.', error);
			new Notice('Whisper.cpp diagnostics failed unexpectedly. Check console for details.', 8_000);
		} finally {
			this.diagnosticsRunning = false;
			if (button) {
				button.setDisabled(false);
				button.setButtonText('Run checks');
			}
		}
	}

	private async toggleLiveDictationFromRibbon(): Promise<void> {
		if (this.dictationSession?.isActive) {
			await this.stopLiveDictation(true);
			return;
		}

		await this.startLiveDictation();
	}

	private async startLiveDictation(): Promise<void> {
		if (this.dictationSession?.isActive) {
			this.logDebug('Start requested while session already active.');
			new Notice('Live dictation is already active.');
			return;
		}

		const editor = this.getActiveEditor();
		if (!editor) {
			this.logDebug('Start blocked because there is no active editor.');
			new Notice('Open a note editor before starting live dictation.');
			return;
		}

		this.dictationRenderState = this.createDictationRenderState(editor);
		this.clearMutableTailForRenderState(this.dictationRenderState);

		this.logDebug('Starting live dictation.', {
			baseUrl: this.settings.baseUrl,
			language: this.settings.language || null,
			requestTimeoutMs: this.settings.requestTimeoutMs,
		});
		const session = new WhisperCppDictationSession({
			baseUrl: this.settings.baseUrl,
			language: this.settings.language,
			requestTimeoutMs: this.settings.requestTimeoutMs,
			partialRequestIntervalMs: this.settings.partialRequestIntervalMs,
			partialMinVoicedMs: this.settings.partialMinVoicedMs,
		}, {
			onTranscript: (update) => {
				this.handleTranscriptUpdate(update);
			},
			onError: (message) => {
				console.error('[Whisper Local] Live dictation error:', message);
				this.logDebug('Live dictation error raised.', { message });
				new Notice(message);
			},
			onDebug: (message, data) => {
				this.logDebug(message, data);
			},
			onStop: () => {
				this.logDebug('Dictation session reported stop.');
				if (this.dictationSession === session) {
					this.dictationSession = null;
					this.updateRibbonToggleState();
				}
				this.resetDictationRenderState();
			},
		});

		this.dictationSession = session;
		this.updateRibbonToggleState();
		try {
			await session.start();
			this.logDebug('Live dictation started.');
			new Notice('Live dictation started.');
			this.updateRibbonToggleState();
		} catch (error) {
			console.error('[Whisper Local] Failed to start live dictation.', error);
			this.logDebug('Failed to start live dictation.', {
				error: error instanceof Error ? error.message : String(error),
			});
			if (this.dictationSession === session) {
				this.dictationSession = null;
			}
			this.resetDictationRenderState();
			this.updateRibbonToggleState();
		}
	}

	private async stopLiveDictation(showNotice: boolean): Promise<void> {
		if (!this.dictationSession) {
			this.logDebug('Stop requested while session is not active.');
			this.resetDictationRenderState();
			if (showNotice) {
				new Notice('Live dictation is not active.');
			}
			return;
		}

		this.logDebug('Stopping live dictation.');
		const session = this.dictationSession;
		this.dictationSession = null;
		this.updateRibbonToggleState();
		this.resetDictationRenderState();
		await session.stop();
		this.logDebug('Live dictation stopped.');
		this.updateRibbonToggleState();

		if (showNotice) {
			new Notice('Live dictation stopped.');
		}
	}

	private handleTranscriptUpdate(update: WhisperCppTranscriptUpdate): void {
		const renderState = this.ensureDictationRenderState();
		if (!renderState) {
			this.logDebug('Transcript update dropped because no render state exists.', update);
			return;
		}

		if (this.getActiveEditor() !== renderState.editor) {
			this.logDebug('Stopping live dictation because active editor changed.');
			void this.stopLiveDictation(false);
			new Notice('Live dictation stopped because active editor changed.');
			return;
		}

		const transcript = update.text.trim();
		if (transcript.length === 0) {
			this.logDebug('Transcript update ignored because text is empty after trimming.', update);
			return;
		}

		if (renderState.activeSequenceId !== update.speechSequenceId) {
			this.flushPendingSequenceTail(renderState, 'sequence_switch');
			renderState.activeSequenceId = update.speechSequenceId;
			renderState.sequenceHypotheses = [];
			renderState.sequenceStableWordCount = 0;
		}

		const previousHypothesis = renderState.sequenceHypotheses[renderState.sequenceHypotheses.length - 1];
			if (previousHypothesis !== transcript) {
				renderState.sequenceHypotheses.push(transcript);
				const maxHypothesisHistory = Math.max(this.settings.stabilizationAgreementWindow + 2, 4);
				if (renderState.sequenceHypotheses.length > maxHypothesisHistory) {
					renderState.sequenceHypotheses.shift();
				}
			}

		if (update.phase === 'final') {
			const remainder = takeWordsRange(transcript, renderState.sequenceStableWordCount);
			this.commitTranscriptText(renderState, remainder);
			this.clearMutableTailForRenderState(renderState);
			renderState.activeSequenceId = null;
			renderState.sequenceHypotheses = [];
			renderState.sequenceStableWordCount = 0;
			this.logDebug('Final transcript committed.', {
				speechSequenceId: update.speechSequenceId,
				remainderLength: remainder.length,
			});
			return;
		}

			const split = splitStableMutableTranscript(
				renderState.sequenceHypotheses,
				renderState.sequenceStableWordCount,
				this.settings.stabilizationAgreementWindow,
			);

		if (split.stableWordCount > renderState.sequenceStableWordCount) {
			const newlyStable = takeWordsRange(
				transcript,
				renderState.sequenceStableWordCount,
				split.stableWordCount,
			);
			this.commitTranscriptText(renderState, newlyStable);
			renderState.sequenceStableWordCount = split.stableWordCount;
		}

		this.renderMutableTailText(renderState, split.mutableText);
		this.logDebug('Applied transcript update.', {
			phase: update.phase,
			speechSequenceId: update.speechSequenceId,
			stableWordCount: renderState.sequenceStableWordCount,
			mutableLength: split.mutableText.length,
		});
	}

	private createDictationRenderState(editor: Editor): DictationRenderState {
		return {
			editor,
			editorView: this.getEditorViewForEditor(editor),
			insertionOffset: editor.posToOffset(editor.getCursor()),
			activeSequenceId: null,
			sequenceHypotheses: [],
			sequenceStableWordCount: 0,
		};
	}

	private ensureDictationRenderState(): DictationRenderState | null {
		if (this.dictationRenderState) {
			this.dictationRenderState.editorView = this.getEditorViewForEditor(this.dictationRenderState.editor)
				?? this.dictationRenderState.editorView;
			return this.dictationRenderState;
		}

		const editor = this.getActiveEditor();
		if (!editor) {
			return null;
		}

		this.dictationRenderState = this.createDictationRenderState(editor);
		return this.dictationRenderState;
	}

	private resetDictationRenderState(): void {
		if (this.dictationRenderState) {
			this.flushPendingSequenceTail(this.dictationRenderState, 'state_reset');
			this.clearMutableTailForRenderState(this.dictationRenderState);
		}
		this.dictationRenderState = null;
	}

	private flushPendingSequenceTail(renderState: DictationRenderState, reason: string): void {
		const bestHypothesis = selectMostCompleteHypothesis(renderState.sequenceHypotheses);
		if (!bestHypothesis) {
			return;
		}

		const pendingRemainder = takeWordsRange(bestHypothesis, renderState.sequenceStableWordCount);
		if (pendingRemainder.length > 0) {
			this.commitTranscriptText(renderState, pendingRemainder);
			this.logDebug('Flushed pending mutable tail.', {
				reason,
				flushedLength: pendingRemainder.length,
			});
		}
	}

	private commitTranscriptText(renderState: DictationRenderState, transcript: string): void {
		const text = formatTranscriptForInsertionAtOffset(
			renderState.editor,
			renderState.insertionOffset,
			transcript,
		);
		if (!text) {
			return;
		}

		this.clearMutableTailForRenderState(renderState);
		const insertionStart = renderState.editor.offsetToPos(renderState.insertionOffset);
		renderState.editor.replaceRange(text, insertionStart);
		renderState.insertionOffset += text.length;
		const insertionEnd = renderState.editor.offsetToPos(renderState.insertionOffset);
		renderState.editor.setCursor(insertionEnd);
	}

	private renderMutableTailText(renderState: DictationRenderState, mutableTail: string): void {
		const editorView = renderState.editorView ?? this.getEditorViewForEditor(renderState.editor);
		if (!editorView) {
			return;
		}
		renderState.editorView = editorView;

		const normalized = mutableTail.trim();
		if (normalized.length === 0) {
			clearMutableTail(editorView);
			return;
		}

		const prefix = needsLeadingSpace(renderState.editor, renderState.insertionOffset) ? ' ' : '';
		setMutableTail(editorView, renderState.insertionOffset, `${prefix}${normalized}`);
	}

	private clearMutableTailForRenderState(renderState: DictationRenderState): void {
		const editorView = renderState.editorView ?? this.getEditorViewForEditor(renderState.editor);
		if (!editorView) {
			return;
		}
		renderState.editorView = editorView;
		clearMutableTail(editorView);
	}

	private getActiveEditor(): Editor | null {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		return view?.editor ?? null;
	}

	private getEditorViewForEditor(editor: Editor): EditorView | null {
		const markdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!markdownView || markdownView.editor !== editor) {
			return null;
		}

		const editorCandidate = markdownView.editor as Editor & { cm?: EditorView };
		return editorCandidate.cm ?? null;
	}

	private updateRibbonToggleState(): void {
		if (!this.ribbonToggleEl) {
			return;
		}

		const isActive = this.dictationSession?.isActive ?? false;
		const tooltip = isActive ? 'Stop live dictation' : 'Start live dictation';
		setIcon(this.ribbonToggleEl, isActive ? 'square' : 'mic');
		this.ribbonToggleEl.setAttribute('aria-label', tooltip);
		this.ribbonToggleEl.setAttribute('title', tooltip);
		this.ribbonToggleEl.classList.toggle('is-active', isActive);
	}

	private applyMutableTailAppearance(): void {
		document.body.style.setProperty(
			'--whisper-local-mutable-tail-opacity',
			this.settings.mutableTailOpacity.toString(),
		);
	}

	private logDebug(message: string, data?: unknown): void {
		const entry: DebugEventEntry = {
			timestamp: new Date().toISOString(),
			message,
			data,
		};
		this.debugEvents.push(entry);
		if (this.debugEvents.length > this.maxDebugEvents) {
			this.debugEvents.shift();
		}

		if (!this.settings.enableDebugLogging) {
			return;
		}

		if (typeof data === 'undefined') {
			console.debug('[Whisper Local][Debug]', message);
			return;
		}

		console.debug('[Whisper Local][Debug]', message, data);
	}

	private printDebugSnapshot(): void {
		const sessionSnapshot = this.dictationSession?.getDebugSnapshot() ?? {
			isActive: false,
		};
		const snapshot = {
			timestamp: new Date().toISOString(),
			pluginVersion: this.manifest.version,
				settings: {
					baseUrl: this.settings.baseUrl,
					language: this.settings.language || null,
					requestTimeoutMs: this.settings.requestTimeoutMs,
					partialRequestIntervalMs: this.settings.partialRequestIntervalMs,
					partialMinVoicedMs: this.settings.partialMinVoicedMs,
					stabilizationAgreementWindow: this.settings.stabilizationAgreementWindow,
					mutableTailOpacity: this.settings.mutableTailOpacity,
					enableDebugLogging: this.settings.enableDebugLogging,
				},
			session: sessionSnapshot,
			renderState: this.dictationRenderState
				? {
					insertionOffset: this.dictationRenderState.insertionOffset,
					activeSequenceId: this.dictationRenderState.activeSequenceId,
					stableWordCount: this.dictationRenderState.sequenceStableWordCount,
				}
				: null,
			lastDiagnosticsSummary: this.lastDiagnosticsReport?.summary ?? null,
			recentEvents: this.debugEvents.slice(-60),
		};

		console.debug('[Whisper Local] Live dictation debug snapshot', snapshot);
		new Notice('Whisper local debug snapshot printed to console.');
	}

	private logDiagnosticsToConsole(report: WhisperCppDiagnosticsReport): void {
		console.debug('[Whisper Local] Diagnostics report', report);
		for (const check of report.checks) {
			const prefix = `[Whisper Local][Diagnostics] ${check.label}: ${check.message}`;
			if (check.status === 'fail') {
				console.error(prefix, check.details ?? null);
				continue;
			}

			if (check.status === 'warn') {
				console.warn(prefix, check.details ?? null);
				continue;
			}

			console.debug(prefix, check.details ?? null);
		}
	}
}

function formatTranscriptForInsertionAtOffset(editor: Editor, insertionOffset: number, transcript: string): string {
	const normalized = transcript.trim();
	if (normalized.length === 0) {
		return '';
	}

	const prefix = needsLeadingSpace(editor, insertionOffset) ? ' ' : '';
	return `${prefix}${normalized} `;
}

function needsLeadingSpace(editor: Editor, insertionOffset: number): boolean {
	if (insertionOffset <= 0) {
		return false;
	}

	const previousChar = editor.getRange(
		editor.offsetToPos(insertionOffset - 1),
		editor.offsetToPos(insertionOffset),
	);
	return previousChar.length > 0 && !/\s/.test(previousChar);
}
