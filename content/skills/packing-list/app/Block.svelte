<script>
	// A section or bag: a strip with its round "whole block" box, progress and edit button, the editor when open, then
	// inner bags, its rows and, for a section, the field to add an item.
	import { flip } from 'svelte/animate';
	import { list, rowKeys } from './model.svelte.js';
	import { ui, motionDuration } from './ui.svelte.js';
	import { indeterminate } from './attachments.js';
	import Block from './Block.svelte';
	import Editor from './Editor.svelte';
	import ItemRow from './ItemRow.svelte';

	let { kind, target, bagsById = null } = $props();

	const keys = $derived([...target.items, ...(target.inner ?? []).flatMap((inner) => inner.items)].flatMap(rowKeys));
	const checkedCount = $derived(list.countChecked(keys));
	const done = $derived(keys.length > 0 && checkedCount === keys.length);
	const editing = $derived(ui.editing?.kind === kind && ui.editing.id === target.id);
	const editTitle = $derived(`Upravit: ${target.title}`);
	let newItem = $state('');

	function addItem(event) {
		event.preventDefault();
		if (list.addItem(target.id, newItem)) newItem = '';
	}
</script>

<section
	class={['category', target.parent && 'inner-bag', target.highlight && 'highlight']}
	data-category-block={target.id}
	data-optional={target.optional || undefined}
	data-done={done || undefined}
	aria-labelledby="heading-{target.id}"
>
	<div class="category-strip">
		<input
			type="checkbox"
			class="toggle-all"
			data-toggle-all
			aria-label="{target.title}: vše"
			checked={done}
			{@attach indeterminate(checkedCount > 0 && checkedCount < keys.length)}
			onchange={(event) => list.setChecked(keys, event.currentTarget.checked)}
		/>
		<span class="category-emoji">{target.emoji}</span>
		<h2 id="heading-{target.id}">{target.title}</h2>
		<span class="section-progress" data-progress={target.id}>{checkedCount} / {keys.length}</span>
		<button type="button" class="edit-block" data-edit-kind={kind} data-edit-id={target.id} title={editTitle} aria-label={editTitle} onclick={() => (ui.editing = { kind, id: target.id })}>✎</button>
	</div>
	{#if editing}
		<Editor {kind} {target} />
	{/if}
	{#if target.note}
		<p class="note">{target.note}</p>
	{/if}
	{#each target.inner ?? [] as inner (inner.id)}
		<Block kind="bag" target={inner} />
	{/each}
	<div class="items" data-drop-list={target.id} data-empty={target.items.length === 0 || undefined}>
		{#each target.items as item (item.id)}
			{@const shown = item.pieceIndexes.length}
			<div
				class={['item', shown > 1 && 'multi', shown > 4 && 'many']}
				data-item-row={item.id}
				data-optional={item.optional || undefined}
				data-done={list.countChecked(rowKeys(item)) === shown || undefined}
				role="group"
				aria-label="{item.label} ×{shown}"
				animate:flip={{ duration: motionDuration(180) }}
			>
				<ItemRow {item} listId={target.id} {bagsById} />
			</div>
		{/each}
	</div>
	{#if kind === 'section'}
		<form class="add-item" data-add-to={target.id} onsubmit={addItem}>
			<input name="label" bind:value={newItem} placeholder="+ přidat, např. Ponožky 3x" aria-label="Přidat do: {target.title}" autocomplete="off" />
			<button type="submit">Přidat</button>
		</form>
	{/if}
</section>
