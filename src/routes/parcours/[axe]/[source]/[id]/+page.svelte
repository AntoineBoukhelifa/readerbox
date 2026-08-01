<script lang="ts">
	import { resolve } from '$app/paths';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const situation = (resultat: (typeof data.resultats)[number]) =>
		[
			resultat.serie,
			resultat.numeroDansLaSerie === null ? null : `n° ${resultat.numeroDansLaSerie}`,
			resultat.dateDeParution
		]
			.filter((morceau): morceau is string => Boolean(morceau))
			.join(' · ');

	const titre = $derived(data.nom ?? `${data.libelle} ${data.idExterne}`);
</script>

<svelte:head><title>{titre} — readerbox</title></svelte:head>

<main class="mx-auto max-w-2xl px-6 py-16">
	<a href={resolve('/search')} class="text-sm text-neutral-500 underline underline-offset-4">
		Chercher
	</a>

	<h1 class="mt-6 text-2xl font-semibold tracking-tight">{titre}</h1>
	<p class="mt-1 text-sm text-neutral-500">{data.libelle} · {data.source}</p>
	<p class="mt-2 text-sm text-neutral-500">
		Ce que la source connaît, pas seulement ce que le groupe a consigné.
	</p>

	{#if form?.message}
		<p class="mt-4 rounded-md border border-neutral-300 bg-neutral-50 p-3 text-sm text-neutral-700">
			{form.message}
		</p>
	{/if}

	{#each data.degradations as degradation (degradation.source)}
		<p class="mt-4 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
			{degradation.message}
		</p>
	{/each}

	{#if !data.axeCouvert}
		<p class="mt-8 text-sm text-neutral-500">
			Cette source ne sait pas parcourir cet axe. Ce n’est pas une panne : elle n’expose pas cette
			donnée.
		</p>
	{:else if data.resultats.length === 0}
		<p class="mt-8 text-sm text-neutral-500">Aucune œuvre rattachée.</p>
	{:else}
		<ul class="mt-8 divide-y divide-neutral-200">
			{#each data.resultats as resultat (resultat.cle)}
				<li class="flex gap-4 py-4">
					{#if resultat.couvertureUrl}
						<img
							src={resultat.couvertureUrl}
							alt=""
							loading="lazy"
							class="h-24 w-16 shrink-0 rounded-sm border border-neutral-200 object-cover"
						/>
					{:else}
						<div
							class="h-24 w-16 shrink-0 rounded-sm border border-dashed border-neutral-200"
						></div>
					{/if}

					<div class="min-w-0 flex-1">
						{#if resultat.oeuvreId}
							<a
								href={resolve('/work/[id]', { id: resultat.oeuvreId })}
								class="text-sm font-medium underline underline-offset-4">{resultat.titre}</a
							>
						{:else}
							<span class="text-sm font-medium">{resultat.titre}</span>
						{/if}

						<p class="mt-1 text-sm text-neutral-500">{situation(resultat)}</p>

						<p class="mt-1 text-xs text-neutral-400">
							{#if resultat.consignee}
								Déjà consignée dans le groupe.
							{:else if resultat.connueDuGroupe}
								Déjà au catalogue du groupe.
							{:else}
								Personne du groupe ne l’a encore.
							{/if}
						</p>

						<form method="POST" action="?/consigner" class="mt-2 flex flex-wrap items-center gap-2">
							<input type="hidden" name="oeuvre" value={resultat.oeuvreId ?? ''} />
							<input type="hidden" name="source" value={resultat.source ?? ''} />
							<input type="hidden" name="idExterne" value={resultat.idExterne ?? ''} />
							<select
								name="etagere"
								class="rounded-md border border-neutral-300 px-2 py-1 text-xs"
								aria-label="Étagère"
							>
								<option value="a_decouvrir">À découvrir</option>
								<option value="en_cours">En cours</option>
								<option value="termine">Terminé</option>
							</select>
							<button
								class="rounded-md border border-neutral-300 bg-white px-3 py-1 text-xs font-medium hover:bg-neutral-100"
							>
								Consigner
							</button>
						</form>
					</div>
				</li>
			{/each}
		</ul>
	{/if}
</main>
