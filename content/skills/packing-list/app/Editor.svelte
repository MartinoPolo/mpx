<script>
	// One editor for sections and bags: icon, name, and for a bag the bag it sits in. target is null for a new one.
	import { list } from './model.svelte.js';
	import { ui } from './ui.svelte.js';

	const sectionIcons = ['☀️', '✈️', '📄', '👕', '👟', '🧴', '💊', '🔌', '💻', '🏊', '🏃', '⛱️', '🎿', '⛺', '👶', '🧸', '🍫', '📚', '🐶', '🏠', '🤔'];
	const bagIcons = ['🧳', '🎒', '🧍', '💼', '👜', '👝', '💊', '💧', '🛍️', '🏋️', '🏖️', '🧊', '🚗', '🛒', '📦', '🟦', '🟩', '🟧'];
	const sectionIdeas = [
		['📄', 'Doklady'], ['👟', 'Boty'], ['🏃', 'Sport'], ['⛱️', 'Pláž'], ['🎿', 'Hory'], ['⛺', 'Kemp'],
		['👶', 'Miminko'], ['🧸', 'Hračky'], ['🍫', 'Jídlo na cestu'], ['📚', 'Zábava'], ['🐶', 'Pes'], ['🏠', 'Zařídit doma'],
	];
	const bagIdeas = [
		['👝', 'Toaletka'], ['💊', 'Lékárnička'], ['💧', 'Tekutiny do letadla'], ['🟦', 'Kostka velká'], ['🟩', 'Kostka střední'],
		['🟧', 'Kostka malá'], ['💼', 'Brašna na notebook'], ['👜', 'Kabelka'], ['🛍️', 'Taška'], ['🏋️', 'Sportovní taška'],
		['🏖️', 'Plážová taška'], ['🧊', 'Chladicí taška'], ['🚗', 'Kufr auta'], ['🛒', 'Kočárek'],
	];

	let { kind, target } = $props();
	const isSection = $derived(kind === 'section');
	const noun = $derived(isSection ? 'sekce' : 'zavazadla');
	const fallbackEmoji = $derived(isSection ? '🗂️' : '👜');
	const deletable = $derived(isSection ? target?.deletable : target && !target.main);
	let form;
	let armed = $state(false);

	const close = () => (ui.editing = null);

	function pick(emoji, title) {
		form.elements.emoji.value = emoji;
		if (title === undefined) return;
		form.elements.title.value = title;
		form.elements.title.focus();
	}

	// The fields are read on submit rather than bound, so nothing re-renders while typing.
	function save(event) {
		event.preventDefault();
		const values = { title: form.elements.title.value, emoji: form.elements.emoji.value.trim() || fallbackEmoji };
		let saved;
		if (isSection) {
			saved = target ? list.saveSection(target.id, values) : list.addSection(values);
		} else {
			values.parent = form.elements.parent.value || undefined;
			saved = target ? list.saveBag(target.id, values) : list.addBag(values);
		}
		if (saved) close();
		else form.elements.title.focus();
	}

	// A second click confirms, since the page cannot show a dialog.
	function remove() {
		if (!armed) {
			armed = true;
			return;
		}
		if (isSection) list.deleteSection(target.id);
		else list.deleteBag(target.id);
		close();
	}
</script>

<form class="editor" data-editor={kind} data-editor-id={target?.id ?? ''} bind:this={form} onsubmit={save}>
	<div class="editor-name">
		<input class="editor-emoji" name="emoji" value={target?.emoji ?? fallbackEmoji} aria-label="Ikona {noun}" autocomplete="off" />
		<input
			class="editor-title"
			name="title"
			value={target?.title ?? ''}
			placeholder={isSection ? 'Název sekce' : 'Název zavazadla'}
			aria-label="Název {noun}"
			autocomplete="off"
			{@attach (input) => input.focus()}
		/>
	</div>
	{#if !isSection}
		<label class="editor-place" title={target?.main ? 'Hlavní zavazadlo zůstává samostatné' : target?.hasChildren ? 'Má v sobě další zavazadla' : undefined}
			>Uvnitř:
			<select name="parent" disabled={target?.main || target?.hasChildren}>
				<option value="">nic, samostatné zavazadlo</option>
				{#each list.bags.filter((bag) => !bag.parent && bag.id !== target?.id) as bag (bag.id)}
					<option value={bag.id} selected={bag.id === target?.parent}>{bag.emoji} {bag.title}</option>
				{/each}
			</select>
		</label>
	{/if}
	<div class="editor-icons" aria-label="Ikony">
		{#each isSection ? sectionIcons : bagIcons as icon (icon)}
			<button type="button" data-pick-icon={icon} onclick={() => pick(icon)}>{icon}</button>
		{/each}
	</div>
	{#if !target}
		<div class="editor-ideas">
			{#each isSection ? sectionIdeas : bagIdeas as [icon, title] (title)}
				<button type="button" data-idea-icon={icon} data-idea-title={title} onclick={() => pick(icon, title)}>{icon} {title}</button>
			{/each}
		</div>
	{/if}
	<div class="editor-actions">
		<button type="submit" class="save">Uložit</button>
		<button type="button" data-editor-cancel onclick={close}>Zrušit</button>
		{#if deletable}
			<button
				type="button"
				class="editor-delete"
				data-editor-delete
				data-armed={armed || undefined}
				title={isSection ? 'Smazat prázdnou sekci' : 'Smazat, věci se přesunou o úroveň výš'}
				onclick={remove}>{armed ? 'Opravdu smazat?' : 'Smazat'}</button
			>
		{/if}
	</div>
</form>
