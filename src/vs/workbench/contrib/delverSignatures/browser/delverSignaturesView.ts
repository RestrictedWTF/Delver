/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { DelverSignaturePolicy, DelverSignatureScope, DelverSignatureVariant, IDelverNamedSignature, IDelverSignatureWildcard } from '../../../../platform/delver/common/delverSignature.js';
import { ITreeItem, ITreeViewDataProvider, TreeItemCollapsibleState } from '../../../common/views.js';
import { DELVER_SIGNATURES_COPY_PATTERN_COMMAND, DELVER_SIGNATURES_GO_TO_COMMAND, DELVER_SIGNATURES_SAVED_HANDLE_PREFIX, DELVER_SIGNATURES_SEARCH_COMMAND, delverRevisionSignatureHandle, IDelverRevisionSignatureResult, IDelverRevisionSignatureScanState, IDelverSignatureSearchMatch, IDelverSignatureSearchState } from './delverSignaturesState.js';

const SEARCH_GROUP_HANDLE = 'delver.signatures.searchResults';
const REVISION_SCAN_GROUP_HANDLE = 'delver.signatures.revisionScan';
const SAVED_GROUP_HANDLE = 'delver.signatures.saved';

/** Presents transient matches and durable named signatures in one compact evidence view. */
export class DelverSignaturesTreeDataProvider implements ITreeViewDataProvider {
	private search: IDelverSignatureSearchState | undefined;
	private revisionScan: IDelverRevisionSignatureScanState | undefined;
	private signatures: readonly IDelverNamedSignature[] = [];

	setSearch(search: IDelverSignatureSearchState | undefined): void {
		this.search = search;
	}

	setRevisionScan(scan: IDelverRevisionSignatureScanState | undefined): void {
		this.revisionScan = scan;
	}

	setSignatures(signatures: readonly IDelverNamedSignature[]): void {
		this.signatures = signatures;
	}

	async getChildren(element?: ITreeItem): Promise<readonly ITreeItem[]> {
		if (!element) {
			const roots: ITreeItem[] = [];
			if (this.search) {
				roots.push(searchGroup(this.search));
			}
			if (this.revisionScan) {
				roots.push(revisionScanGroup(this.revisionScan));
			}
			if (this.signatures.length > 0) {
				roots.push({
					handle: SAVED_GROUP_HANDLE,
					label: { label: localize('delverSavedSignatures', "Saved Signatures") },
					description: String(this.signatures.length),
					themeIcon: ThemeIcon.fromId(Codicon.bookmark.id),
					collapsibleState: TreeItemCollapsibleState.Expanded,
				});
			}
			return roots;
		}
		if (element.handle === SEARCH_GROUP_HANDLE) {
			const matches = this.search?.matches.map(searchMatchItem) ?? [];
			if (this.search?.nextCursor) {
				return [...matches, {
					handle: 'delver.signatures.loadMore',
					label: { label: localize('delverSignatureLoadMore', "Load More Matches...") },
					themeIcon: ThemeIcon.fromId(Codicon.more.id),
					collapsibleState: TreeItemCollapsibleState.None,
					command: {
						id: DELVER_SIGNATURES_SEARCH_COMMAND,
						title: localize('delverSignatureLoadMoreCommand', "Load More Matches"),
						arguments: [this.search.pattern, this.search.nextCursor, true],
					},
				}];
			}
			return matches;
		}
		if (element.handle === REVISION_SCAN_GROUP_HANDLE) {
			return this.revisionScan?.results.map(revisionScanResultItem) ?? [];
		}
		if (element.handle === SAVED_GROUP_HANDLE) {
			return this.signatures.map(savedSignatureItem);
		}
		const revisionResult = this.revisionScan?.results.find(candidate => element.handle === delverRevisionSignatureHandle(candidate));
		if (revisionResult?.status === 'ambiguous') {
			return revisionResult.matches.map((match, index) => revisionScanMatchItem(revisionResult, match, index));
		}
		const signature = this.signatures.find(candidate => element.handle === savedSignatureHandle(candidate));
		if (signature) {
			return savedSignatureEvidence(signature);
		}
		const wildcardSignature = this.signatures.find(candidate => element.handle === savedSignatureWildcardsHandle(candidate));
		if (wildcardSignature) {
			return wildcardSignature.wildcards.map((wildcard, index) => savedSignatureWildcardItem(wildcardSignature, wildcard, index));
		}
		return [];
	}
}

function revisionScanGroup(scan: IDelverRevisionSignatureScanState): ITreeItem {
	const uniqueCount = scan.results.filter(result => result.status === 'unique').length;
	return {
		handle: REVISION_SCAN_GROUP_HANDLE,
		label: { label: localize('delverEarlierRevisionScan', "Earlier Revision Scan") },
		description: scan.omittedCount > 0
			? localize('delverEarlierRevisionScanLimitedSummary', "{0}/{1} unique · {2} omitted", uniqueCount, scan.results.length, scan.omittedCount)
			: localize('delverEarlierRevisionScanSummary', "{0}/{1} unique", uniqueCount, scan.results.length),
		tooltip: localize('delverEarlierRevisionScanTooltip', "Saved patterns from earlier project revisions tested against target {0}.", scan.targetContentHash),
		themeIcon: ThemeIcon.fromId(Codicon.history.id),
		collapsibleState: TreeItemCollapsibleState.Expanded,
	};
}

function revisionScanResultItem(result: IDelverRevisionSignatureResult): ITreeItem {
	const uniqueMatch = result.status === 'unique' ? result.matches[0] : undefined;
	return {
		handle: delverRevisionSignatureHandle(result),
		contextValue: result.status === 'unique'
			? `delver-revision-signature-unique-${result.signature.variant}`
			: `delver-revision-signature-${result.status}`,
		label: { label: result.signature.name },
		description: revisionScanResultDescription(result),
		tooltip: revisionScanResultTooltip(result),
		themeIcon: revisionScanResultIcon(result),
		collapsibleState: result.status === 'ambiguous' && result.matches.length > 0
			? TreeItemCollapsibleState.Collapsed
			: TreeItemCollapsibleState.None,
		...(uniqueMatch ? { command: goToCommand(uniqueMatch.rva) } : {}),
	};
}

function revisionScanMatchItem(result: IDelverRevisionSignatureResult, match: IDelverSignatureSearchMatch, index: number): ITreeItem {
	return {
		handle: `${delverRevisionSignatureHandle(result)}.match.${index}.${match.rva}`,
		label: { label: `${match.section}:${match.rva}` },
		description: spacedBytes(match.bytesHex),
		tooltip: localize('delverEarlierSignatureMatchTooltip', "Candidate match at image RVA {0} in {1}. Click to inspect it in the listing.", match.rva, match.section),
		themeIcon: ThemeIcon.fromId(Codicon.location.id),
		collapsibleState: TreeItemCollapsibleState.None,
		command: goToCommand(match.rva),
	};
}

function revisionScanResultDescription(result: IDelverRevisionSignatureResult): string {
	const source = result.revision.displayName;
	switch (result.status) {
		case 'unique': {
			const match = result.matches[0];
			return localize('delverEarlierSignatureUnique', "unique · {0} · {1}:{2}", source, match.section, match.rva);
		}
		case 'ambiguous':
			return localize('delverEarlierSignatureAmbiguous', "{0}{1} matches · {2}", result.matches.length, result.detail ? '+' : '', source);
		case 'missing':
			return localize('delverEarlierSignatureMissing', "not found · {0}", source);
		case 'incomplete':
			return localize('delverEarlierSignatureIncomplete', "not verified · {0}", source);
	}
}

function revisionScanResultTooltip(result: IDelverRevisionSignatureResult): string {
	const evidence = localize(
		'delverEarlierSignatureEvidenceTooltip',
		"Source revision: {0}\nSource hash: {1}\nSource function: {2} ({3})\nPattern: {4}",
		result.revision.displayName,
		result.revision.contentHash,
		result.signature.functionName,
		result.signature.functionRva,
		result.signature.pattern.toUpperCase(),
	);
	switch (result.status) {
		case 'unique': return `${evidence}\n${localize('delverEarlierSignatureUniqueTooltip', "Exactly one match was found in the current target. This proves relocation for this revision, not stability across every future revision.")}`;
		case 'ambiguous': return `${evidence}\n${result.detail ?? localize('delverEarlierSignatureAmbiguousTooltip', "Multiple exact matches were found in the current target.")}`;
		case 'missing': return `${evidence}\n${localize('delverEarlierSignatureMissingTooltip', "No match was found after a complete scan of the current target.")}`;
		case 'incomplete': return `${evidence}\n${result.detail ?? localize('delverEarlierSignatureIncompleteTooltip', "The current target could not be scanned completely.")}`;
	}
}

function revisionScanResultIcon(result: IDelverRevisionSignatureResult): ThemeIcon {
	switch (result.status) {
		case 'unique': return Codicon.verified;
		case 'ambiguous': return Codicon.warning;
		case 'missing': return Codicon.circleSlash;
		case 'incomplete': return Codicon.error;
	}
}

function searchGroup(search: IDelverSignatureSearchState): ITreeItem {
	const count = search.matches.length;
	return {
		handle: SEARCH_GROUP_HANDLE,
		label: { label: localize('delverSignatureSearchResults', "Search Results") },
		description: localize(
			'delverSignatureSearchSummary',
			"{0}{1} matches · {2}",
			count,
			search.completeness === 'partial' ? '+' : '',
			search.pattern,
		),
		tooltip: localize('delverSignatureSearchTooltip', "Pattern: {0}", search.pattern),
		themeIcon: ThemeIcon.fromId(Codicon.search.id),
		collapsibleState: count > 0 || search.nextCursor ? TreeItemCollapsibleState.Expanded : TreeItemCollapsibleState.None,
	};
}

function searchMatchItem(match: IDelverSignatureSearchMatch, index: number): ITreeItem {
	return {
		handle: `delver.signatures.match.${index}.${match.rva}`,
		contextValue: 'delver-signature-match',
		label: { label: `${match.section}:${match.rva}` },
		description: spacedBytes(match.bytesHex),
		tooltip: localize('delverSignatureMatchTooltip', "Image RVA {0} in {1}\nBytes: {2}", match.rva, match.section, spacedBytes(match.bytesHex)),
		themeIcon: ThemeIcon.fromId(Codicon.location.id),
		collapsibleState: TreeItemCollapsibleState.None,
		command: {
			id: DELVER_SIGNATURES_GO_TO_COMMAND,
			title: localize('delverSignatureGoToMatch', "Go to Signature Match"),
			arguments: [match.rva],
		},
	};
}

function savedSignatureItem(signature: IDelverNamedSignature): ITreeItem {
	return {
		handle: savedSignatureHandle(signature),
		contextValue: signature.variant === 'primary' ? 'delver-saved-signature-primary' : 'delver-saved-signature',
		label: { label: signature.name },
		description: localize(
			'delverSavedSignatureSummary',
			"{0} · {1}/{2} fixed",
			signature.confidence,
			signature.fixedByteCount,
			signature.byteCount,
		),
		tooltip: localize(
			'delverSavedSignatureTooltip',
			"Function: {0} ({1})\nPattern: {2}\nClick to search the attached image.",
			signature.functionName,
			signature.functionRva,
			signature.pattern.toUpperCase(),
		),
		themeIcon: ThemeIcon.fromId(Codicon.key.id),
		collapsibleState: TreeItemCollapsibleState.Collapsed,
		command: {
			id: DELVER_SIGNATURES_SEARCH_COMMAND,
			title: localize('delverSearchSavedSignature', "Search Saved Signature"),
			arguments: [signature.pattern],
		},
	};
}

function savedSignatureEvidence(signature: IDelverNamedSignature): readonly ITreeItem[] {
	const items: ITreeItem[] = [
		{
			handle: `${savedSignatureHandle(signature)}.pattern`,
			label: { label: localize('delverSavedSignaturePattern', "Pattern") },
			description: signature.pattern.toUpperCase(),
			tooltip: localize('delverSavedSignaturePatternTooltip', "IDA-style pattern: {0}\nClick to copy.", signature.pattern.toUpperCase()),
			themeIcon: ThemeIcon.fromId(Codicon.copy.id),
			collapsibleState: TreeItemCollapsibleState.None,
			command: {
				id: DELVER_SIGNATURES_COPY_PATTERN_COMMAND,
				title: localize('delverCopySavedSignaturePattern', "Copy Signature Pattern"),
				arguments: [signature.pattern],
			},
		},
		{
			handle: `${savedSignatureHandle(signature)}.function`,
			label: { label: localize('delverSavedSignatureFunction', "Function") },
			description: `${signature.functionName} · ${signature.functionRva}`,
			tooltip: localize('delverSavedSignatureFunctionTooltip', "Function {0} at image RVA {1}. Click to open it in the listing.", signature.functionName, signature.functionRva),
			themeIcon: ThemeIcon.fromId(Codicon.symbolFunction.id),
			collapsibleState: TreeItemCollapsibleState.None,
			command: goToCommand(signature.functionRva),
		},
		{
			handle: `${savedSignatureHandle(signature)}.strategy`,
			label: { label: localize('delverSavedSignatureStrategy', "Strategy") },
			description: localize('delverSavedSignatureStrategyValue', "{0} · {1} · {2}", variantLabel(signature.variant), policyLabel(signature.policy), scopeLabel(signature.scope)),
			themeIcon: ThemeIcon.fromId(Codicon.settings.id),
			collapsibleState: TreeItemCollapsibleState.None,
		},
		{
			handle: `${savedSignatureHandle(signature)}.coverage`,
			label: { label: localize('delverSavedSignatureCoverage', "Covered Bytes") },
			description: localize('delverSavedSignatureCoverageValue', "{0}–{1} · {2} bytes", signature.coveredStartRva, signature.coveredEndRva, signature.byteCount),
			tooltip: localize('delverSavedSignatureCoverageTooltip', "Image RVA range {0} through {1}. Click to open its first byte in the listing.", signature.coveredStartRva, signature.coveredEndRva),
			themeIcon: ThemeIcon.fromId(Codicon.bracketDot.id),
			collapsibleState: TreeItemCollapsibleState.None,
			command: goToCommand(signature.coveredStartRva),
		},
		{
			handle: `${savedSignatureHandle(signature)}.proof`,
			label: { label: localize('delverSavedSignatureProof', "Uniqueness Proof") },
			description: proofLabel(signature),
			themeIcon: ThemeIcon.fromId(signature.unique ? Codicon.verified.id : Codicon.warning.id),
			collapsibleState: TreeItemCollapsibleState.None,
		},
		{
			handle: `${savedSignatureHandle(signature)}.quality`,
			label: { label: localize('delverSavedSignatureQuality', "Quality") },
			description: localize('delverSavedSignatureQualityValue', "{0} confidence · {1}% score · {2}/{3} fixed bytes", signature.confidence, Math.round(signature.qualityScore * 100), signature.fixedByteCount, signature.byteCount),
			themeIcon: ThemeIcon.fromId(Codicon.graph.id),
			collapsibleState: TreeItemCollapsibleState.None,
		},
	];
	if (signature.wildcards.length > 0) {
		items.push({
			handle: savedSignatureWildcardsHandle(signature),
			label: { label: localize('delverSavedSignatureWildcards', "Wildcarded Operands") },
			description: signature.wildcards.length === 1
				? localize('delverSavedSignatureWildcardCountSingle', "{0} bytes in 1 field", signature.wildcardByteCount)
				: localize('delverSavedSignatureWildcardCount', "{0} bytes in {1} fields", signature.wildcardByteCount, signature.wildcards.length),
			themeIcon: ThemeIcon.fromId(Codicon.symbolField.id),
			collapsibleState: TreeItemCollapsibleState.Expanded,
		});
	}
	return items;
}

function savedSignatureWildcardItem(signature: IDelverNamedSignature, wildcard: IDelverSignatureWildcard, index: number): ITreeItem {
	const lastPatternByte = wildcard.patternByteIndex + wildcard.length - 1;
	const byteLabel = wildcard.length === 1
		? localize('delverSavedSignatureWildcardByte', "Byte {0}", wildcard.patternByteIndex)
		: localize('delverSavedSignatureWildcardBytes', "Bytes {0}–{1}", wildcard.patternByteIndex, lastPatternByte);
	return {
		handle: `${savedSignatureWildcardsHandle(signature)}.${index}`,
		label: { label: byteLabel },
		description: localize('delverSavedSignatureWildcardSummary', "{0} · {1}", wildcard.instructionRva, wildcardReasonLabel(wildcard)),
		tooltip: localize(
			'delverSavedSignatureWildcardTooltip',
			"Pattern byte {0}, instruction byte {1}, length {2}. Wildcarded because this is {3}. Click to open the instruction.",
			wildcard.patternByteIndex,
			wildcard.instructionByteIndex,
			wildcard.length,
			wildcardReasonLabel(wildcard),
		),
		themeIcon: ThemeIcon.fromId(Codicon.question.id),
		collapsibleState: TreeItemCollapsibleState.None,
		command: goToCommand(wildcard.instructionRva),
	};
}

function savedSignatureHandle(signature: IDelverNamedSignature): string {
	return `${DELVER_SIGNATURES_SAVED_HANDLE_PREFIX}${signature.id}`;
}

function savedSignatureWildcardsHandle(signature: IDelverNamedSignature): string {
	return `${savedSignatureHandle(signature)}.wildcards`;
}

function goToCommand(rva: string): ITreeItem['command'] {
	return {
		id: DELVER_SIGNATURES_GO_TO_COMMAND,
		title: localize('delverSignatureGoToEvidence', "Go to Signature Evidence"),
		arguments: [rva],
	};
}

function variantLabel(variant: DelverSignatureVariant): string {
	return variant === 'primary'
		? localize('delverSignaturePrimaryVariant', "primary")
		: localize('delverSignatureXrefVariant', "xref site");
}

function policyLabel(policy: DelverSignaturePolicy): string {
	return policy === 'unique-now'
		? localize('delverSignatureUniqueNowPolicy', "unique now")
		: localize('delverSignatureRelocationStablePolicy', "relocation stable");
}

function scopeLabel(scope: DelverSignatureScope): string {
	switch (scope) {
		case 'function': return localize('delverSignatureFunctionScope', "function");
		case 'executableSections': return localize('delverSignatureExecutableSectionsScope', "executable sections");
		case 'image': return localize('delverSignatureImageScope', "image");
	}
}

function proofLabel(signature: IDelverNamedSignature): string {
	const scope = scopeLabel(signature.scope);
	if (!signature.matchCountExact) {
		return localize('delverSavedSignaturePartialProof', "At least {0} matches · {1}", signature.matchCount, scope);
	}
	return signature.matchCount === 1
		? localize('delverSavedSignatureUniqueProof', "1 exact match · {0}", scope)
		: localize('delverSavedSignatureExactProof', "{0} exact matches · {1}", signature.matchCount, scope);
}

function wildcardReasonLabel(wildcard: IDelverSignatureWildcard): string {
	switch (wildcard.reason) {
		case 'relativeBranch': return localize('delverSignatureRelativeBranchWildcard', "a relative branch target");
		case 'ipRelativeMemory': return localize('delverSignatureIpRelativeWildcard', "an instruction-pointer-relative memory reference");
		case 'baseRelocation': return localize('delverSignatureBaseRelocationWildcard', "an image-base relocation");
	}
}

function spacedBytes(bytesHex: string): string {
	return bytesHex.toUpperCase().replace(/(..)(?=.)/g, '$1 ');
}
