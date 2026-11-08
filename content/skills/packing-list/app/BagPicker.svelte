<script>
	// A menu of every bag, inner bags indented under theirs, opened from an item's or a piece's badge.
	import { tick } from 'svelte';
	import { list } from './model.svelte.js';
	import { ui } from './ui.svelte.js';

	// Read from ui rather than passed as props, which a closing picker would still read after ui.picker is gone.
	const itemId = $derived(ui.picker?.itemId);
	const pieceIndex = $derived(ui.picker?.pieceIndex);
	const badge = $derived(ui.picker?.badge);
	const item = $derived(list.categories.flatMap((category) => category.items).find((candidate) => candidate.id === itemId));
	const current = $derived(pieceIndex === undefined ? item?.bagId : item?.pieceBagIds[pieceIndex]);
	const heading = $derived(pieceIndex === undefined ? (item?.count > 1 ? 'všechny kusy' : 'kam') : `${pieceIndex + 1}. kus`);

	function place(menu) {
		const rect = badge.getBoundingClientRect();
		menu.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - menu.offsetWidth - 8)) + window.scrollX}px`;
		menu.style.top = `${rect.bottom + window.scrollY + 4}px`;
		menu.querySelector('[aria-checked="true"]')?.focus();
	}

	async function pick(bagId) {
		list.setBag(itemId, bagId, pieceIndex);
		ui.picker = null;
		await tick();
		document.querySelector(`[data-item-row="${itemId}"] [data-item-action="bag"]`)?.focus();
	}
</script>

{#if item}
	<div class="bag-picker" role="menu" {@attach place}>
		<p>{item.label}: {heading}</p>
		{#each list.bags as bag (bag.id)}
			<button type="button" class={{ inner: bag.parent }} role="menuitemradio" aria-checked={bag.id === current} data-pick-bag={bag.id} onclick={() => pick(bag.id)}
				>{bag.emoji} {bag.title}</button
			>
		{/each}
	</div>
{/if}
