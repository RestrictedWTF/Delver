/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { MenuId } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr, ContextKeyExpression, IContextKey, IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

/**
 * What the analyst has selected, and therefore what an action can act on.
 *
 * This is the whole point of the type: an action binds to a *kind of object*,
 * never to a container. "Generate Signature" acts on a function, so it can only
 * appear while a function is selected — which makes the misplacement that put it
 * in unrelated view title bars unrepresentable rather than merely discouraged.
 * See `Docs/design/workspace.md` §5.
 */
export type DelverSelectionKind =
	| 'none'
	| 'function'
	| 'instruction'
	| 'string'
	| 'section'
	| 'import'
	| 'export'
	| 'xref'
	| 'proposal';

export interface IDelverSelection {
	readonly kind: DelverSelectionKind;
	/**
	 * The selected object's address, as the `"0x..."` wire form.
	 *
	 * A string rather than a `bigint` because context-key values must be
	 * primitives a `when` clause can compare, and `bigint` is not one. The wire
	 * form is the same one used everywhere else, so nothing is lost above 2^53
	 * (invariant 2).
	 */
	readonly address?: string;
}

export const DELVER_SELECTION_NONE: IDelverSelection = { kind: 'none' };

export const DELVER_SELECTION_KIND = new RawContextKey<string>('delverSelectionKind', 'none');
export const DELVER_SELECTION_ADDRESS = new RawContextKey<string>('delverSelectionAddress', '');

/**
 * The one menu Delver object-scoped actions contribute to.
 *
 * Declared here rather than on upstream's `MenuId` class so no upstream file is
 * touched (invariant 11). Its constructor is public and throws on a duplicate
 * identifier, so this is a supported use.
 */
export const MenuDelverSelectionContext = new MenuId('DelverSelectionContext');

/** `when` clause matching any of the given selection kinds. */
export function whenSelectionIs(...kinds: readonly DelverSelectionKind[]): ContextKeyExpression {
	const clauses = kinds.map(kind => DELVER_SELECTION_KIND.isEqualTo(kind));
	return clauses.length === 1 ? clauses[0] : ContextKeyExpr.or(...clauses)!;
}

export const IDelverSelectionService = createDecorator<IDelverSelectionService>('delverSelectionService');

export interface IDelverSelectionService {
	readonly _serviceBrand: undefined;
	readonly selection: IDelverSelection;
	readonly onDidChangeSelection: Event<IDelverSelection>;
	setSelection(selection: IDelverSelection): void;
}

/**
 * Holds what is selected and mirrors it into context keys.
 *
 * One service rather than per-surface keys: only one thing is selected at a
 * time across the workspace, and two surfaces each owning their own key would
 * let a stale one keep an action enabled after focus moved elsewhere.
 */
export class DelverSelectionService extends Disposable implements IDelverSelectionService {
	readonly _serviceBrand: undefined;

	private readonly _onDidChangeSelection = this._register(new Emitter<IDelverSelection>());
	readonly onDidChangeSelection = this._onDidChangeSelection.event;

	private _selection: IDelverSelection = DELVER_SELECTION_NONE;
	private readonly kindKey: IContextKey<string>;
	private readonly addressKey: IContextKey<string>;

	constructor(@IContextKeyService contextKeyService: IContextKeyService) {
		super();
		this.kindKey = DELVER_SELECTION_KIND.bindTo(contextKeyService);
		this.addressKey = DELVER_SELECTION_ADDRESS.bindTo(contextKeyService);
	}

	get selection(): IDelverSelection {
		return this._selection;
	}

	setSelection(selection: IDelverSelection): void {
		if (selection.kind === this._selection.kind && selection.address === this._selection.address) {
			return;
		}
		this._selection = selection;
		this.kindKey.set(selection.kind);
		this.addressKey.set(selection.address ?? '');
		this._onDidChangeSelection.fire(selection);
	}
}

registerSingleton(IDelverSelectionService, DelverSelectionService, InstantiationType.Delayed);
