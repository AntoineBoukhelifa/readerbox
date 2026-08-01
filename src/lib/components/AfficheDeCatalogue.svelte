<script lang="ts">
	import { resolve } from '$app/paths';
	import { ETAGERES_AFFICHEES, type EtatDAffiche } from '$lib/affichage';
	import Affiche from './Affiche.svelte';

	/**
	 * Une affiche de catalogue : la couverture, ce qu'elle est, et le geste de
	 * consignation sous elle.
	 *
	 * Les deux surfaces qui parcourent le catalogue — la recherche et le parcours
	 * par facette — rendent exactement la même chose, et la rendaient jusqu'ici
	 * en double. Une seule forme, donc, pour que le geste le plus fréquent du
	 * produit soit au même endroit d'un écran à l'autre.
	 *
	 * **Trois boutons plutôt qu'une liste déroulante suivie d'un bouton.** F1 dit
	 * que consigner un numéro qu'on vient de lire est le geste le plus fréquent :
	 * il vaut un clic, pas trois. Les trois étagères de R1 sont là, et l'abandon
	 * n'y est pas — R2 en fait un état distinct, qui se pose depuis la page de
	 * l'œuvre.
	 */
	interface Props {
		titre: string;
		couvertureUrl: string | null;
		/** `null` tant que l'œuvre n'est pas au catalogue : rien à ouvrir encore. */
		oeuvreId: string | null;
		/** La référence amont, que le versement ingérera au besoin. */
		source: string | null;
		idExterne: string | null;
		situation: string;
		/** Où j'en suis, si j'y suis. */
		mien: { etagere: string; atteinte: boolean; position: number; note: number | null } | null;
		/** Quelqu'un du groupe l'a-t-il consignée ? Indicatif. */
		consignee: boolean;
		connueDuGroupe: boolean;
		rang?: number;
	}

	let {
		titre,
		couvertureUrl,
		oeuvreId,
		source,
		idExterne,
		situation,
		mien,
		consignee,
		connueDuGroupe,
		rang = 0
	}: Props = $props();

	const etat: EtatDAffiche = $derived(
		mien === null ? 'aucun' : mien.atteinte ? 'atteint' : 'consigne'
	);
</script>

<Affiche
	{titre}
	{couvertureUrl}
	href={oeuvreId === null ? null : resolve('/work/[id]', { id: oeuvreId })}
	{situation}
	{etat}
	note={mien?.note ?? null}
	position={mien?.position ?? 0}
	{rang}
>
	<p class="mt-1 text-[0.7rem] leading-tight text-encre-tenue">
		{#if consignee}
			Consignée dans le groupe
		{:else if connueDuGroupe}
			Au catalogue, sur aucune étagère
		{:else}
			Personne du groupe ne l’a
		{/if}
	</p>

	<form method="POST" action="?/consigner" class="mt-2 flex flex-wrap gap-1">
		<input type="hidden" name="oeuvre" value={oeuvreId ?? ''} />
		<input type="hidden" name="source" value={source ?? ''} />
		<input type="hidden" name="idExterne" value={idExterne ?? ''} />
		{#each ETAGERES_AFFICHEES as etagere (etagere.valeur)}
			<button
				name="etagere"
				value={etagere.valeur}
				data-retenu={mien !== null && !mien.atteinte && mien.etagere === etagere.valeur
					? 'oui'
					: undefined}
				class="action-sourde px-1.5 py-0.5 text-[0.7rem]"
			>
				{etagere.libelle}
			</button>
		{/each}
	</form>
</Affiche>
