/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Whether a model's work waits for a human, or is accepted as it arrives.
 *
 * Review exists because a model's conclusions about a hostile binary are
 * provisional, and the proposed state is how Delver says so. Turning that off
 * is a legitimate choice — an analyst sweeping a known-good sample, or driving
 * an agent they intend to audit in bulk afterwards, is not served by clicking
 * accept four hundred times — but it is a choice about *trust*, and it must not
 * become a choice about *truth*.
 *
 * So automatic acceptance is recorded, never simulated. It appends a real
 * resolution to the append-only log with `kind: 'rule'` as its author, which is
 * exactly what that author kind is for. Nothing anywhere is told a human read
 * something a human did not read: the log distinguishes the two, the review
 * surfaces distinguish them, and an exported report puts automatically accepted
 * findings under their own heading rather than beside reviewed ones.
 *
 * That last part is the whole reason this file is careful. A report is handed
 * to someone who cannot check it, and "accepted" reading as "a person agreed"
 * when nobody looked would be a false claim about the sample — which this
 * project ranks above a crash.
 */

import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IAuthor } from '../../../../platform/delver/common/interpretation.js';

/** Setting that selects the review mode. */
export const DELVER_REVIEW_MODE_SETTING = 'delver.review.mode';

/**
 * How proposals are decided.
 *
 * `manual` is the default, and deliberately: a mode that accepts a model's
 * claims unread is not a safe thing to arrive at by not choosing.
 */
export type DelverReviewMode = 'manual' | 'auto';

/**
 * The author recorded for an automatic acceptance.
 *
 * `rule` rather than `human`, and a stable id rather than the analyst's name.
 * Reusing the local human author here would put a person's name against work
 * they never saw — which is the one thing this feature must not do, and the
 * easiest thing for it to have done.
 */
export const DELVER_AUTO_REVIEWER: IAuthor = { kind: 'rule', id: DELVER_REVIEW_MODE_SETTING };

/** Whether an author is the automatic reviewer rather than a person. */
export function isAutomaticReview(author: IAuthor | undefined): boolean {
	return author?.kind === 'rule' && author.id === DELVER_AUTO_REVIEWER.id;
}

/**
 * Reads the configured mode, settling anything unrecognised to `manual`.
 *
 * Fails closed on a value it does not understand — a typo in settings, or a
 * project written by a newer build — because the failure directions are not
 * symmetric. Defaulting to `manual` costs the analyst some clicking; defaulting
 * to `auto` accepts a model's conclusions nobody asked it to accept.
 */
export function delverReviewMode(configurationService: IConfigurationService): DelverReviewMode {
	return configurationService.getValue(DELVER_REVIEW_MODE_SETTING) === 'auto' ? 'auto' : 'manual';
}
