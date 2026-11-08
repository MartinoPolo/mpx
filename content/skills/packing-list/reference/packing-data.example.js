// Item ids are persistence keys: keep them stable when labels, counts or sections change.
// Each item has a photo at images/<id>.webp; emoji is the fallback.
// Section flags: `highlight` = the departure-morning section in the blue box;
// `optional` = decided while packing, so it stays out of the overall tally.
// `bags` (optional) lists the bags of the second layout in display order; leave it out for suitcase, backpack and
// worn. `mainBag` names the bag every item starts in (default: the first). `parent` puts a bag inside a top-level one (toiletry bag, packing cube); one level only.
// `bag` on a section or an item puts it in another bag; the viewer can still move it, piece by piece.
window.PACKING_TRIP = {
	// Prefix for the browser storage and the artifact's shared database document; never change it after publishing.
	storageKey: 'kreta-2027-packing',
	// The artifact's name in the gallery and the browser tab; keep it stable across republishes.
	pageTitle: 'Balení na Krétu',
	title: 'Kréta',
	dates: '4.–11. 5. 2027',
	subtitle: '7 nocí · letadlo · jaro u moře',
	facts: [
		'🏨 Hotel u pláže (bazén, polopenze)',
		'🌤️ 18–25 °C, voda 19 °C',
		'🧳 kufr 20 kg + příruční zavazadlo',
	],
	mainBag: 'kufr',
	bags: [
		{ id: 'na-sebe', title: 'Na sebe', emoji: '🧍' },
		{ id: 'batoh', title: 'Batoh', emoji: '🎒' },
		{ id: 'kufr', title: 'Kufr', emoji: '🧳' },
		{ id: 'toaletka', title: 'Toaletka', emoji: '👝', parent: 'kufr' },
	],
	categories: [
		{
			id: 'rano',
			title: 'Ráno',
			emoji: '☀️',
			highlight: true,
			note: 'den odjezdu',
			items: [
				{ id: 'kartacek-pasta', label: 'Kartáček + pasta', emoji: '🪥', count: 1 },
				{ id: 'mobil', label: 'Mobil', emoji: '📱', count: 1, bag: 'batoh' },
				{ id: 'penezenka', label: 'Peněženka + karty', emoji: '👛', count: 1 },
			],
		},
		{
			id: 'elektro',
			title: 'Elektro',
			emoji: '🔌',
			items: [{ id: 'nabijecka-mobil', label: 'Nabíječka USB-C', emoji: '🔌', count: 1 }],
		},
		{
			id: 'obleceni',
			title: 'Oblečení',
			emoji: '👕',
			items: [
				{ id: 'mikina', label: 'Mikina', emoji: '🧥', count: 1, bag: 'na-sebe' },
				{ id: 'trenky', label: 'Trenky', emoji: '🩲', count: 8 },
				{ id: 'ponozky', label: 'Ponožky', emoji: '🧦', count: 8 },
			],
		},
		{
			id: 'mozna',
			title: 'Možná',
			emoji: '🤔',
			optional: true,
			items: [{ id: 'powerbanka', label: 'Powerbanka', emoji: '🔋', count: 1 }],
		},
	],
};
