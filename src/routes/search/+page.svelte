<script lang="ts">
	import { resolve } from '$app/paths';
	import AfficheDeCatalogue from '$lib/components/AfficheDeCatalogue.svelte';
	import Grille from '$lib/components/Grille.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	/**
	 * Les titres sont rendus par interpolation, jamais par un rendu de balisage
	 * brut. Un titre de catalogue vient d’une source tierce : s’il contient des
	 * chevrons, il doit s’afficher comme texte littéral, et c’est l’échappement de
	 * Svelte qui le garantit — pas un nettoyage à l’ingestion, qui abîmerait la
	 * donnée sans protéger les surfaces qu’on écrira ensuite.
	 */
	const situation = (resultat: (typeof data.resultats)[number]) =>
		[
			resultat.type,
			resultat.serie,
			resultat.numeroDansLaSerie === null ? null : `n° ${resultat.numeroDansLaSerie}`,
			resultat.dateDeParution
		]
			.filter((morceau): morceau is string => Boolean(morceau))
			.join(' · ');
</script>

<svelte:head><title>Chercher — readerbox</title></svelte:head>

<main class="mx-auto w-full max-w-6xl flex-1 px-5 py-10">
	<h1 class="font-display text-2xl leading-none tracking-tight">Chercher</h1>
	<p class="mt-2 max-w-2xl text-sm leading-relaxed text-encre-basse">
		Tout l’univers, pas seulement ce que le groupe a déjà consigné. Un numéro précis se demande avec
		son rang : « Immortal X-Men #1 ».
	</p>

	<form method="GET" class="mt-6 flex max-w-xl flex-wrap gap-2">
		<label class="min-w-0 flex-1">
			<span class="sr-only">Ce que tu cherches</span>
			<input name="q" value={data.requete} placeholder="Immortal X-Men" class="champ w-full" />
		</label>
		<button class="action">Chercher</button>
	</form>

	{#if form?.message}
		<p class="mt-4 border-l-2 border-trait bg-cimaise px-4 py-3 text-sm text-encre-basse">
			{form.message}
		</p>
	{/if}

	<!-- Une source qui ne répond pas dégrade la page, elle ne la fait pas échouer. -->
	{#each data.degradations as degradation (degradation.source)}
		<p class="mt-4 border-l-2 border-or-sourd bg-cimaise px-4 py-3 text-sm text-encre-basse">
			{degradation.message}
		</p>
	{/each}

	{#if data.requete.trim() === ''}
		<p class="mt-10 max-w-xl text-sm leading-relaxed text-encre-tenue">
			Un titre de série, un film, une série télévisée. Ce que tu trouves n’a pas besoin d’avoir été
			consigné par qui que ce soit.
		</p>
	{:else if data.resultats.length === 0}
		<p class="mt-10 text-sm text-encre-tenue">Rien sous ce nom.</p>
	{:else}
		<div class="mt-10">
			<Grille>
				{#each data.resultats as resultat, rang (resultat.cle)}
					<li>
						<AfficheDeCatalogue
							titre={resultat.titre}
							couvertureUrl={resultat.couvertureUrl}
							oeuvreId={resultat.oeuvreId}
							source={resultat.source}
							idExterne={resultat.idExterne}
							situation={situation(resultat)}
							mien={resultat.mien}
							consignee={resultat.consignee}
							connueDuGroupe={resultat.connueDuGroupe}
							{rang}
						/>

						{#if resultat.serieSource && resultat.serieIdExterne}
							<p class="mt-1">
								<a
									href={resolve('/parcours/[axe]/[source]/[id]', {
										axe: 'serie',
										source: resultat.serieSource,
										id: resultat.serieIdExterne
									})}
									class="lien text-[0.7rem] text-encre-tenue">Toute la série</a
								>
							</p>
						{/if}
					</li>
				{/each}
			</Grille>
		</div>
	{/if}
</main>
