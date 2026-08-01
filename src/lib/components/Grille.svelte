<script lang="ts">
	import type { Snippet } from 'svelte';

	/**
	 * La grille d'affiches — la forme de lecture par défaut du produit.
	 *
	 * Elle revient sur toutes les surfaces qui listent des œuvres : la recherche,
	 * le parcours, le journal d'un membre, la séquence d'un ordre. C'est ce qui
	 * fait qu'on reconnaît le produit d'un écran à l'autre, et c'est aussi ce qui
	 * rend l'état lisible en un balayage — vingt affiches côte à côte, celles
	 * qu'on a atteintes portent leur liseré d'or.
	 *
	 * Deux densités seulement. La grille **serrée** est faite pour être parcourue
	 * — un journal, une séquence — ; la grille **large** laisse la place aux
	 * gestes qui viennent sous chaque affiche, comme les trois étagères de la
	 * recherche.
	 */
	interface Props {
		serree?: boolean;
		children: Snippet;
	}

	let { serree = false, children }: Props = $props();
</script>

<ul
	class="grid gap-x-4 gap-y-7 {serree
		? 'grid-cols-3 sm:grid-cols-4 lg:grid-cols-6'
		: 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-5'}"
>
	{@render children()}
</ul>
