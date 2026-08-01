<script lang="ts">
	/**
	 * La note en étoiles (R4), en un glyphe compact.
	 *
	 * Deux rangées superposées plutôt qu'une chaîne composée : la rangée d'or
	 * est rognée à la largeur exacte de la note, ce qui rend la demi-étoile
	 * juste au pixel près là où « ★★★½ » la rend approximativement. Une note
	 * moyenne de groupe vaut 3,7 et non 3,5 — elle mérite d'être vue telle
	 * quelle.
	 *
	 * L'or est ici à sa place : une note **est** un état, pas un ornement.
	 */
	interface Props {
		/** Sur cinq. `null` n'affiche rien — l'appelant dit alors ce qu'il veut. */
		valeur: number;
		/** Le libellé lu par un lecteur d'écran, qui ne voit pas les étoiles. */
		etiquette?: string;
	}

	let { valeur, etiquette }: Props = $props();

	const largeur = $derived(`${Math.max(0, Math.min(1, valeur / 5)) * 100}%`);
	const dit = $derived(
		etiquette ?? `${valeur.toString().replace('.', ',')} étoile${valeur > 1 ? 's' : ''} sur 5`
	);
</script>

<span class="relative inline-block align-baseline leading-none tracking-[0.1em] whitespace-nowrap">
	<span aria-hidden="true" class="text-trait">★★★★★</span>
	<span
		aria-hidden="true"
		class="absolute inset-y-0 left-0 overflow-hidden text-or"
		style="width: {largeur}">★★★★★</span
	>
	<span class="sr-only">{dit}</span>
</span>
