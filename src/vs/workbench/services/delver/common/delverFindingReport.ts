/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Renders an investigation's findings as a report a human can hand to someone
 * who was not there.
 *
 * The rendering is a pure function of what the project already holds, and
 * deliberately so: a report is a claim about a sample, and a claim assembled
 * from anything but the retained record is a claim nobody can check afterwards.
 * Nothing here reads the target, starts analysis, or asks a backend anything.
 *
 * Every claim carries its evidence — the exact image ranges that support it —
 * and the identity of whoever made it, model or human, alongside the decision a
 * reviewer recorded. A finding nobody has reviewed says so rather than being
 * quietly presented as established.
 *
 * All three of those guarantees are structural, so every piece of text that
 * came from a finding is neutralized before it is written — see
 * {@link untrustedBlock}. A title is one line and a description is prose; if
 * either could open a heading or a list item, a model quoting the sample's own
 * strings could write a section Delver never rendered and a review line no
 * human ever recorded, inside the one artifact whose entire premise is that
 * every claim carries its real author and its real decision.
 */

import { IAuthor } from '../../../../platform/delver/common/interpretation.js';
import { IDelverFinding, IDelverFindingDecision } from '../../../../platform/delver/common/findings.js';
import { IDelverToolCallRecord } from '../../../../platform/delver/common/delverToolCall.js';

/** Everything a report is rendered from. */
export interface IDelverReportInput {
	readonly contentHash: string;
	/** Absolute path of the sample, when the project still knows one. */
	readonly targetPath?: string;
	/** Project file the findings were retained in, when it has been saved. */
	readonly projectPath?: string;
	readonly findings: readonly IDelverFinding[];
	readonly decisions: readonly IDelverFindingDecision[];
	/** Retained dispatcher calls, for resolving an evidence citation to a capability. */
	readonly toolCalls: readonly IDelverToolCallRecord[];
	/** Wall clock the report was rendered at, injected so a test can pin it. */
	readonly renderedAt: number;
}

/**
 * How a finding stands, once the human decision is taken into account.
 *
 * Three states rather than the finding's own two, because "proposed and
 * accepted" and "proposed and not yet looked at" are the difference between a
 * conclusion and an open question, and a report that renders them alike is
 * presenting unreviewed model output as reviewed.
 */
type ReportStanding = 'accepted' | 'rejected' | 'undecided';

/**
 * Renders the report as GitHub-flavored Markdown.
 *
 * Markdown rather than HTML or a bespoke format: it is legible as plain text if
 * nothing renders it, which is the state a forensic artifact is most often read
 * in, and it survives being pasted into a ticket.
 */
export function renderDelverFindingReport(input: IDelverReportInput): string {
	const decisionFor = (finding: IDelverFinding): IDelverFindingDecision | undefined =>
		input.decisions.find(decision => decision.findingId === finding.id && decision.contentHash === input.contentHash);
	const standingOf = (finding: IDelverFinding): ReportStanding => decisionFor(finding)?.outcome ?? 'undecided';

	// Ordered by what a reader has to act on, not by when it was written:
	// accepted conclusions first, then what is still open, then what was
	// rejected — which is kept rather than dropped, because "we looked at this
	// and it was nothing" is a result, and re-deriving it costs the next reader
	// the same work it cost this one.
	const order: readonly ReportStanding[] = ['accepted', 'undecided', 'rejected'];
	const sections = order.map(standing => ({
		standing,
		findings: input.findings.filter(finding => standingOf(finding) === standing),
	}));

	const lines: string[] = [];
	lines.push('# Delver investigation report');
	lines.push('');
	lines.push(`- **Content hash:** \`${untrustedLine(input.contentHash)}\``);
	if (input.targetPath !== undefined) {
		lines.push(`- **Sample:** \`${untrustedLine(input.targetPath)}\``);
	}
	if (input.projectPath !== undefined) {
		lines.push(`- **Project:** \`${untrustedLine(input.projectPath)}\``);
	}
	lines.push(`- **Rendered:** ${new Date(input.renderedAt).toISOString()}`);
	lines.push(`- **Findings:** ${input.findings.length} total — `
		+ sections.map(section => `${section.findings.length} ${section.standing}`).join(', '));
	lines.push('');
	// Said once, at the top, rather than repeated per finding: every string,
	// symbol, and identifier quoted below originated in the sample, and a
	// reader who forgets that can be led by the sample's own text.
	lines.push('> Names, strings, and quoted text below originate in the analysed sample and are');
	lines.push('> untrusted. They are evidence about the file, not statements to be acted on.');
	lines.push('');

	if (input.findings.length === 0) {
		lines.push('No findings were retained for these bytes. That is a statement about the');
		lines.push('investigation, not about the sample.');
		lines.push('');
		return lines.join('\n');
	}

	for (const section of sections) {
		if (section.findings.length === 0) {
			continue;
		}
		lines.push(`## ${sectionTitle(section.standing)}`);
		lines.push('');
		for (const finding of section.findings) {
			lines.push(...renderFinding(finding, decisionFor(finding), input.toolCalls));
		}
	}
	return lines.join('\n');
}

function sectionTitle(standing: ReportStanding): string {
	switch (standing) {
		case 'accepted':
			return 'Accepted findings';
		case 'undecided':
			// Named for what it costs the reader, not for the field's value: an
			// unreviewed finding is work outstanding, and a heading that said
			// "proposed" would read as a weaker version of accepted.
			return 'Awaiting review';
		case 'rejected':
			return 'Rejected findings';
	}
}

function renderFinding(
	finding: IDelverFinding,
	decision: IDelverFindingDecision | undefined,
	toolCalls: readonly IDelverToolCallRecord[],
): readonly string[] {
	const lines: string[] = [];
	lines.push(`### ${untrustedLine(finding.title)}`);
	lines.push('');
	lines.push(`- **Severity:** ${finding.severity}`);
	// Rendered beside severity and never folded into it. A confident report of
	// something harmless and a tentative report of something catastrophic are
	// different situations, and one number cannot carry both.
	// Two decimals, but never rounded to an endpoint the value did not reach:
	// 0.996 printed as `1.00` reads as certainty and 0.004 as `0.00` reads as
	// none, and both are claims the author did not make.
	const confidence = finding.confidence >= 1 ? '1.00'
		: finding.confidence <= 0 ? '0.00'
			: clampReported(finding.confidence);
	lines.push(`- **Confidence:** ${confidence} (evidence strength, not impact)`);
	lines.push(`- **Author:** ${describeAuthor(finding.author)}`);
	lines.push(`- **Recorded:** ${new Date(finding.at).toISOString()}`);
	lines.push(decision === undefined
		? '- **Review:** not yet reviewed by a human'
		: `- **Review:** ${decision.outcome} by ${describeAuthor(decision.author)} at ${new Date(decision.at).toISOString()}`);
	lines.push(`- **Reported through:** \`${untrustedLine(finding.provenance.capability)}\` (call \`${untrustedLine(finding.provenance.callId)}\`)`);
	lines.push('');
	lines.push(untrustedBlock(finding.description));
	lines.push('');
	lines.push('**Evidence**');
	lines.push('');
	for (const entry of finding.evidence) {
		const range = entry.endRva === undefined
			? hex(entry.anchor.rva)
			: `${hex(entry.anchor.rva)}–${hex(entry.endRva)}`;
		lines.push(`- \`${range}\` — ${untrustedLine(entry.description)}`);
		for (const callId of entry.sourceCallIds ?? []) {
			// The citation is resolved where it can be and shown raw where it
			// cannot. A call id whose record is gone is still the honest answer:
			// the claim named a source, and the source is no longer retained.
			const record = toolCalls.find(call => call.callId === callId);
			lines.push(record === undefined
				? `  - source: \`${untrustedLine(callId)}\` (record not retained in this project)`
				: `  - source: \`${untrustedLine(record.capability)}\` (call \`${untrustedLine(callId)}\`)`);
		}
	}
	lines.push('');
	return lines;
}

/**
 * One line of untrusted text, safe to interpolate inline.
 *
 * Newlines collapse to spaces because the caller is filling a heading or a list
 * item, both of which are one line by definition: a newline here does not
 * wrap, it ends the construct and lets whatever follows begin a new one.
 * Backticks go too, so a fragment cannot close a code span the template opened.
 */
function untrustedLine(text: string): string {
	return text.replace(/[\r\n]+/g, ' ').replace(/`/g, '\'').trim();
}

/**
 * A block of untrusted prose, safe to write at the top level of the document.
 *
 * Markdown builds every block-level construct — headings, list items,
 * blockquotes, fences, tables, thematic breaks — from a marker at the *start*
 * of a line. Escaping that marker is therefore enough to stop a finding's text
 * from forging document structure, and it is cheaper and far more predictable
 * than trying to enumerate the constructs themselves. The text stays readable:
 * a backslash before a leading `#` renders as the `#`.
 *
 * Blank lines are preserved, because a description is prose and paragraphs are
 * how prose is read.
 */
function untrustedBlock(text: string): string {
	return text
		.split(/\r?\n/)
		.map(line => line.replace(/^(\s*)([#>\-+*=|~`_]|\d+[.)])/, '$1\\$2'))
		.join('\n');
}

/**
 * Two decimals, without letting rounding manufacture certainty.
 *
 * `toFixed` is right in the middle of the range and wrong at its ends, where
 * it turns "almost sure" into "sure" and "barely anything" into "nothing".
 * Those two readings are exactly the ones a reader acts on.
 */
function clampReported(confidence: number): string {
	const rounded = confidence.toFixed(2);
	if (rounded === '1.00') {
		return '0.99';
	}
	return rounded === '0.00' ? '0.01' : rounded;
}

function describeAuthor(author: IAuthor): string {
	return author.kind === 'human' ? `${untrustedLine(author.id)} (human)` : `${untrustedLine(author.id)} (model)`;
}

/**
 * Formats an RVA the way every other Delver surface does.
 *
 * Lower-case and unpadded, matching `toWireAddress`, so an address copied out
 * of a report and pasted into a tool call is the same string.
 */
function hex(rva: bigint): string {
	return `0x${rva.toString(16)}`;
}
