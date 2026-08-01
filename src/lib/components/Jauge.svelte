<script lang="ts">
	/**
	 * La progression dans un ordre, en une barre.
	 *
	 * L'or est ici à sa place : la progression est un état, et c'est même celui
	 * que le produit tient pour le plus important après l'atteinte. Le
	 * pourcentage compte les entrées essentielles atteintes (R20) et rien
	 * d'autre.
	 *
	 * `null` n'est ni zéro ni cent : c'est un ordre dont rien n'est essentiel —
	 * vide, ou entièrement facultatif. La barre disparaît alors plutôt que de
	 * rester vide, ce qui se lirait comme un reproche adressé à quelqu'un qui
	 * n'a rien à faire.
	 */
	interface Props {
		pourcentage: number | null;
		/** Le libellé chiffré, à droite de la barre. */
		etiquette?: string;
	}

	let { pourcentage, etiquette }: Props = $props();
</script>

<div class="flex items-center gap-3">
	{#if pourcentage === null}
		<span class="text-xs text-encre-tenue">rien d’essentiel</span>
	{:else}
		<span class="relative h-[3px] min-w-16 flex-1 bg-trait" aria-hidden="true">
			<span class="absolute inset-y-0 left-0 bg-or" style="width: {pourcentage}%"></span>
		</span>
		<span class="font-display text-sm whitespace-nowrap text-or tabular-nums">
			{etiquette ?? `${pourcentage} %`}
		</span>
	{/if}
</div>
