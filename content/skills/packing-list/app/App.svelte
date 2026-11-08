<script>
	// The page: header with tally, legend and actions, then the list in one of two layouts, by section or by bag
	// (suitcase, backpack, worn on the way, and bags inside them such as a toiletry bag).
	import { flushSync } from 'svelte';
	import { list, rowKeys } from './model.svelte.js';
	import { ui, layouts, setLayout, setUnpackedOnly } from './ui.svelte.js';
	import Block from './Block.svelte';
	import Editor from './Editor.svelte';
	import BagPicker from './BagPicker.svelte';

	const trip = window.PACKING_TRIP;
	// The artifact frame cannot print.
	const printable = !window.PACKING_ARTIFACT;
	const root = document.documentElement;
	const layoutLabels = { categories: '🗂️ Sekce', bags: '🧳 Zavazadla' };

	const bagsById = $derived(new Map(list.bags.map((bag) => [bag.id, bag])));
	const legend = $derived(
		list.bags
			.filter((bag) => !bag.parent)
			.map((bag) => {
				const inner = list.bags.filter((child) => child.parent === bag.id).map((child) => `${child.emoji} ${child.title}`);
				return `${bag.emoji} ${bag.title}${inner.length ? ` (${inner.join(', ')})` : ''}`;
			}),
	);

	// packing-theme.js resolves and toggles the theme; the artifact host can also switch it while the page is open.
	let dark = $state(root.dataset.theme === 'dark');
	$effect(() => {
		const observer = new MutationObserver(() => (dark = root.dataset.theme === 'dark'));
		observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
		return () => observer.disconnect();
	});
	$effect(() => {
		root.dataset.activeLayout = ui.layout;
	});
	$effect(() => {
		if (ui.unpackedOnly) root.dataset.unpackedOnly = '';
		else delete root.dataset.unpackedOnly;
	});

	// Three columns, as on the printed A4 page, fewer on narrow screens.
	const narrow = window.matchMedia('(max-width: 960px)');
	const phone = window.matchMedia('(max-width: 620px)');
	let printing = $state(false);
	let screenColumns = $state(0);
	const readColumns = () => (screenColumns = phone.matches ? 1 : narrow.matches ? 2 : 3);
	readColumns();
	const columnCount = $derived(printing ? 3 : screenColumns);
	$effect(() => {
		const beforePrint = () => flushSync(() => (printing = true));
		const afterPrint = () => (printing = false);
		narrow.addEventListener('change', readColumns);
		phone.addEventListener('change', readColumns);
		window.addEventListener('beforeprint', beforePrint);
		window.addEventListener('afterprint', afterPrint);
		return () => {
			narrow.removeEventListener('change', readColumns);
			phone.removeEventListener('change', readColumns);
			window.removeEventListener('beforeprint', beforePrint);
			window.removeEventListener('afterprint', afterPrint);
		};
	});

	// Rows are all about one photo high, so a section's height is estimated from its rows. Sections stay in order: the
	// smallest column height that still fits them all is found by bisection, then they are dealt out up to it.
	// Rows hidden by the unpacked-only filter take no room, and a block with none left is hidden whole.
	const packed = (item) => list.countChecked(rowKeys(item)) === item.pieceIndexes.length;
	function blockHeight(block) {
		const rows = ui.unpackedOnly ? block.items.filter((item) => !packed(item)) : block.items;
		if (ui.unpackedOnly && block.items.length && !rows.length) return 0;
		return 1.2 + (block.note ? 0.5 : 0) + 0.8 + rows.reduce((sum, item) => sum + (item.pieceIndexes.length > 4 ? 1.7 : 1), 0);
	}
	function dealColumns(blocks, count, limit) {
		const columns = [[]];
		let height = 0;
		for (const block of blocks) {
			const blockSize = blockHeight(block);
			if (columns.at(-1).length && height + blockSize > limit) {
				columns.push([]);
				height = 0;
			}
			columns.at(-1).push(block);
			height += blockSize;
		}
		return columns.length <= count ? columns : null;
	}
	function flowColumns(blocks, count) {
		let low = Math.max(...blocks.map(blockHeight));
		let high = blocks.reduce((sum, block) => sum + blockHeight(block), 0);
		while (high - low > 0.25) {
			const middle = (low + high) / 2;
			if (dealColumns(blocks, count, middle)) high = middle;
			else low = middle;
		}
		const columns = dealColumns(blocks, count, high);
		while (columns.length < count) columns.push([]);
		return columns;
	}
	const sectionColumns = $derived(flowColumns(list.categories, columnCount));

	// Unticking everything asks for a second click instead of a dialog.
	let resetArmed = $state(false);
	let resetTimeout;
	function reset() {
		clearTimeout(resetTimeout);
		if (!resetArmed) {
			resetArmed = true;
			resetTimeout = setTimeout(() => (resetArmed = false), 3000);
			return;
		}
		resetArmed = false;
		list.clearChecked();
	}

	function closePicker(refocus) {
		const { itemId, badge } = ui.picker;
		ui.picker = null;
		if (refocus) (badge.isConnected ? badge : document.querySelector(`[data-item-row="${itemId}"] [data-item-action="bag"]`))?.focus();
	}

	function onWindowClick(event) {
		if (ui.picker && !event.target.closest('.bag-picker, [data-item-action="bag"]')) closePicker(false);
	}

	function onWindowKeydown(event) {
		if (event.key !== 'Escape') return;
		if (ui.picker) closePicker(true);
		else ui.editing = null;
	}
</script>

<svelte:window onclick={onWindowClick} onkeydown={onWindowKeydown} />

{#snippet newBlock(kind, text)}
	<section class="category add-block">
		{#if ui.editing?.kind === kind && ui.editing.id === null}
			<Editor {kind} target={null} />
		{:else}
			<button type="button" class="add-new" data-edit-kind={kind} data-edit-id="" onclick={() => (ui.editing = { kind, id: null })}>{text}</button>
		{/if}
	</section>
{/snippet}

<main class="sheet">
	<header>
		<div class="title-line">
			<h1>{trip.title}</h1>
			<span class="meta"><strong>{trip.dates}</strong> · <span>{trip.subtitle}</span></span>
		</div>
		<div class="tally"><span data-progress="all">{list.tally.checked} / {list.tally.total}</span> <span class="meta">sbaleno</span></div>
		<div class="bar" data-progress-bar="all" role="presentation" style:--progress={list.tally.total ? list.tally.checked / list.tally.total : 0}></div>
		<ul class="facts">
			{#each trip.facts ?? [] as fact (fact)}
				<li>{fact}</li>
			{/each}
		</ul>
		<ul class="bag-legend" data-bag-legend aria-label="Zavazadla">
			{#each legend as entry (entry)}
				<li>{entry}</li>
			{/each}
		</ul>
		<div class="actions">
			<div class="layout-switch" role="group" aria-label="Rozložení">
				{#each layouts as layout (layout)}
					<button type="button" data-layout={layout} aria-pressed={ui.layout === layout} onclick={() => setLayout(layout)}>{layoutLabels[layout]}</button>
				{/each}
			</div>
			{#if printable}
				<button type="button" data-action="print" onclick={() => window.print()}>🖨️ Vytisknout</button>
			{/if}
			<button type="button" data-action="unpacked-only" aria-pressed={ui.unpackedOnly} onclick={() => setUnpackedOnly(!ui.unpackedOnly)}>{ui.unpackedOnly ? '👁️ Zobrazit vše' : '📦 Jen nesbalené'}</button>
			<button type="button" data-action="reset" data-armed={resetArmed || undefined} onclick={reset}>{resetArmed ? 'Opravdu vše odškrtnout?' : 'Odškrtnout vše'}</button>
			{#if list.edits.deleted.length}
				<button type="button" data-action="restore" onclick={() => list.restoreDeleted()}>↩︎ Vrátit smazané ({list.edits.deleted.length})</button>
			{/if}
			<button type="button" data-action="theme" aria-pressed={dark}>{dark ? '☀️ Světlý režim' : '🌙 Tmavý režim'}</button>
		</div>
		{#if ui.syncFailing}
			<p class="sync-warning" data-sync-warning role="status">
				⚠️ Změny se ukládají jen v tomto prohlížeči, na další zařízení se nedostanou. Otevři seznam z účtu, který ho vlastní.
			</p>
		{/if}
	</header>
	<div class="categories" data-categories style:--columns={columnCount}>
		{#if ui.layout === 'bags'}
			{#each list.bagSections as bag (bag.id)}
				<Block kind="bag" target={bag} />
			{/each}
			{@render newBlock('bag', '+ Nové zavazadlo')}
		{:else}
			{#each sectionColumns as column, index (index)}
				<div class="column">
					{#each column as category (category.id)}
						<Block kind="section" target={category} {bagsById} />
					{/each}
					{#if index === sectionColumns.length - 1}
						{@render newBlock('section', '+ Nová sekce')}
					{/if}
				</div>
			{/each}
		{/if}
	</div>
</main>

<BagPicker />
