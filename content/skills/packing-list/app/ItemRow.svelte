<script>
	// The inside of an item row. It leads with one box in a fixed column: the piece itself, or a round "all pieces" box
	// whose piece boxes follow at the row's end. bagsById is given in the section layout, for the badge on the photo and
	// the small one above each piece box; listId keeps the lead box id unique when an item shows in several bags.
	import { tick } from 'svelte';
	import { list, maxCount, pieceKey, rowKeys } from './model.svelte.js';
	import { ui } from './ui.svelte.js';
	import { startDrag } from './drag.js';
	import { indeterminate } from './attachments.js';

	let { item, listId, bagsById = null } = $props();

	const keys = $derived(rowKeys(item));
	const checkedCount = $derived(list.countChecked(keys));
	const leadId = $derived(`lead-${item.id}-${listId}`);
	const bag = $derived(bagsById?.get(item.bagId));
	// Items added on the page live only in the database, so they get a photo only once one is embedded under their id.
	const photo = $derived(window.PACKING_PHOTOS?.[item.id] ?? (item.custom ? null : `images/${item.id}.webp`));
	let photoFailed = $state(false);

	const setPiece = (index, event) => list.setChecked([pieceKey(item.id, index)], event.currentTarget.checked);
	const openPicker = (event, pieceIndex) => (ui.picker = { itemId: item.id, pieceIndex, badge: event.currentTarget });

	// When the used button disappears (no more pieces to add or remove), keyboard focus stays in the row.
	async function changeCount(event, change) {
		const row = event.currentTarget.closest('[data-item-row]');
		list.changeCount(item.id, change);
		await tick();
		if (row.contains(document.activeElement)) return;
		row.querySelector(`[data-item-action="${change > 0 ? 'more' : 'fewer'}"], [data-item-action="more"]`)?.focus();
	}

	async function moveByKey(event) {
		if (!['ArrowUp', 'ArrowDown'].includes(event.key)) return;
		event.preventDefault();
		const toList = list.moveByKey(ui.layout, item.id, listId, event.key === 'ArrowUp' ? -1 : 1);
		if (!toList) return;
		await tick();
		document.querySelector(`[data-drop-list="${toList}"] > [data-item-row="${item.id}"] [data-drag-handle]`)?.focus();
	}
</script>

{#snippet pieceBox(index, extraClass = '')}
	{@const key = pieceKey(item.id, index)}
	<input
		type="checkbox"
		class="piece {extraClass}"
		id={extraClass ? leadId : undefined}
		data-key={key}
		aria-label="{item.label} {index + 1} z {item.count}"
		checked={list.checked.has(key)}
		onchange={(event) => setPiece(index, event)}
	/>
{/snippet}

{#snippet badge(bagOfBadge, className, pieceIndex)}
	{@const title = `${bagOfBadge.title}, klepnutím změníš ${pieceIndex === undefined ? 'zavazadlo' : `${pieceIndex + 1}. kus`}: ${item.label}`}
	<button
		type="button"
		class={className}
		data-item-action="bag"
		data-item-id={item.id}
		data-piece={pieceIndex}
		{title}
		aria-label={title}
		onclick={(event) => openPicker(event, pieceIndex)}>{bagOfBadge.emoji}</button
	>
{/snippet}

{#if keys.length > 1}
	<input
		type="checkbox"
		class="toggle-all lead"
		id={leadId}
		data-toggle-all
		aria-label="{item.label}: všechny kusy"
		checked={checkedCount === keys.length}
		{@attach indeterminate(checkedCount > 0 && checkedCount < keys.length)}
		onchange={(event) => list.setChecked(keys, event.currentTarget.checked)}
	/>
{:else}
	{@render pieceBox(item.pieceIndexes[0], 'lead')}
{/if}

<span class="visual">
	{#if photo && !photoFailed}
		<img class="photo" src={photo} alt="" onerror={() => (photoFailed = true)} />
	{:else}
		<span class="emoji">{item.emoji}</span>
	{/if}
	{#if bag}
		<!-- Most items stay in the main bag, so its badge steps back and the others stand out. -->
		{@render badge(bag, ['bag-badge', bag.main && 'main-bag'], undefined)}
	{/if}
</span>

<label class="label" for={leadId}
	>{item.label}{#if keys.length < item.count}<span class="part"> {keys.length} z {item.count}</span>{/if}</label
>

{#if keys.length > 1}
	<span class="pieces">
		{#each item.pieceIndexes as index (index)}
			{#if bagsById}
				{@const pieceBagId = item.pieceBagIds[index]}
				<span class="piece">
					{@render badge(bagsById.get(pieceBagId), ['piece-bag', pieceBagId === item.bagId && 'same'], index)}
					{@render pieceBox(index)}
				</span>
			{:else}
				{@render pieceBox(index)}
			{/if}
		{/each}
	</span>
{/if}

<!-- Delete on top, add a piece in the middle, remove a piece at the bottom; a button that cannot apply leaves its slot empty. -->
<span class="item-controls">
	<button type="button" class="delete" data-item-action="delete" data-item-id={item.id} title="Smazat: {item.label}" aria-label="Smazat: {item.label}" onclick={() => list.deleteItem(item.id)}>×</button>
	{#if item.count < maxCount}
		<button type="button" class="more" data-item-action="more" data-item-id={item.id} title="Přidat kus: {item.label}" aria-label="Přidat kus: {item.label}" onclick={(event) => changeCount(event, 1)}>+</button>
	{/if}
	{#if item.count > 1}
		<button type="button" class="fewer" data-item-action="fewer" data-item-id={item.id} title="Ubrat kus: {item.label}" aria-label="Ubrat kus: {item.label}" onclick={(event) => changeCount(event, -1)}>−</button>
	{/if}
</span>
<button
	type="button"
	class="grip"
	data-item-action="grip"
	data-item-id={item.id}
	data-drag-handle
	title="Přetáhnout (nebo šipky nahoru a dolů): {item.label}"
	aria-label="Přetáhnout (nebo šipky nahoru a dolů): {item.label}"
	onpointerdown={(event) => startDrag(event, (drop) => list.move(ui.layout, drop))}
	onkeydown={moveByKey}>⠿</button
>
