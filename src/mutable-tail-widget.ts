import { StateEffect, StateField, type Extension } from '@codemirror/state';
import { Decoration, EditorView, type DecorationSet, WidgetType } from '@codemirror/view';

interface MutableTailPayload {
	position: number;
	text: string;
}

class MutableTailTextWidget extends WidgetType {
	private readonly text: string;

	constructor(text: string) {
		super();
		this.text = text;
	}

	toDOM(): HTMLElement {
		const element = document.createElement('span');
		element.className = 'whisper-local-mutable-tail';
		element.textContent = this.text;
		return element;
	}

	ignoreEvent(): boolean {
		return true;
	}
}

const setMutableTailEffect = StateEffect.define<MutableTailPayload | null>();

const mutableTailField = StateField.define<DecorationSet>({
	create() {
		return Decoration.none;
	},
	update(value, transaction) {
		let next = value.map(transaction.changes);
		for (const effect of transaction.effects) {
			if (!effect.is(setMutableTailEffect)) {
				continue;
			}

			const payload = effect.value;
			if (!payload || payload.text.trim().length === 0) {
				next = Decoration.none;
				continue;
			}

			const clampedPosition = Math.max(0, Math.min(payload.position, transaction.state.doc.length));
			next = Decoration.set([
				Decoration.widget({
					widget: new MutableTailTextWidget(payload.text),
					side: 1,
				}).range(clampedPosition),
			]);
		}

		return next;
	},
	provide(field) {
		return EditorView.decorations.from(field);
	},
});

export const whisperLocalMutableTailExtension: Extension = [
	mutableTailField,
];

export function setMutableTail(editorView: EditorView, position: number, text: string): void {
	editorView.dispatch({
		effects: setMutableTailEffect.of({
			position,
			text,
		}),
	});
}

export function clearMutableTail(editorView: EditorView): void {
	editorView.dispatch({
		effects: setMutableTailEffect.of(null),
	});
}
