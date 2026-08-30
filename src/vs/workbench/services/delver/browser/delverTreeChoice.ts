/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * A persistent choice a tree surface shows above its tree.
 *
 * Delver's tree surfaces render inside the workspace editor's zones, not as
 * view panes: `registerDelverTreeSurface` registers them with the views
 * registry under `when: false` purely so `TreeView` can find a progress
 * location, and the zone header carries a title, segment tabs, and a state slot
 * documented as *pin and sync only, never actions*. Nothing in that path renders
 * `MenuId.ViewTitle`, so a view-title menu on one of these surfaces is a control
 * no analyst can reach.
 *
 * This is the reachable equivalent, and it deliberately mirrors the filter row
 * rather than inventing a second mechanism: a `WeakMap` the contribution writes
 * and the surface reads, because `TreeView` wraps an assigned data provider in
 * something that exposes only `ITreeViewDataProvider` and cannot forward
 * anything else.
 *
 * Use it for a choice that changes what the surface *means*, not for a command.
 * A control that is always on screen costs vertical space on every render, and
 * only something an analyst has to be able to see without asking earns that.
 */

import { Event } from '../../../../base/common/event.js';
import { ITreeView } from '../../../common/views.js';

/** One selectable value. */
export interface IDelverTreeChoiceOption {
	readonly value: string;
	readonly label: string;
}

/** A labelled choice rendered above a tree surface. */
export interface IDelverTreeChoice {
	/** Shown beside the control, so the choice reads as a sentence. */
	readonly label: string;
	readonly ariaLabel: string;
	readonly options: readonly IDelverTreeChoiceOption[];
	/** The value now in effect. Read on every render and on every change. */
	current(): string;
	select(value: string): void;
	/**
	 * Fires when `current()` would answer differently.
	 *
	 * Required rather than optional: the value can change from somewhere other
	 * than this control — the Settings UI, a workspace file, another window —
	 * and a control that only updated when clicked would sit there displaying a
	 * mode the analyst is no longer in.
	 */
	readonly onDidChange: Event<void>;
}

const choices = new WeakMap<ITreeView, IDelverTreeChoice>();

export function registerDelverTreeChoice(treeView: ITreeView, choice: IDelverTreeChoice): void {
	choices.set(treeView, choice);
}

export function delverTreeChoice(treeView: ITreeView): IDelverTreeChoice | undefined {
	return choices.get(treeView);
}
