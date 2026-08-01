<script lang="ts">
	import { resolve } from '$app/paths';
	import OrderEditor from '$lib/components/OrderEditor.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const dateCourte = (ms: number) =>
		new Date(ms).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });

	/**
	 * R20 — le pourcentage, ou le fait qu'il n'y en ait pas.
	 *
	 * `null` n'est ni 0 % ni 100 % : c'est un ordre dont rien n'est essentiel —
	 * vide, ou entièrement facultatif. Afficher « 0 % » y serait un reproche
	 * adressé à quelqu'un qui n'a rien à faire.
	 */
	function avancement(pourcentage: number | null): string {
		return pourcentage === null ? 'rien d’essentiel' : `${pourcentage} %`;
	}

	const suivante = $derived(
		data.progression.entreeSuivante === null
			? null
			: (data.entrees.find((entree) => entree.id === data.progression.entreeSuivante?.id) ?? null)
	);
</script>

<svelte:head><title>{data.ordre.titre} — readerbox</title></svelte:head>

<main class="mx-auto max-w-2xl px-6 py-16">
	<a href={resolve('/orders')} class="text-sm text-neutral-500 underline underline-offset-4">
		Les ordres
	</a>

	<h1 class="mt-6 text-2xl font-semibold tracking-tight">{data.ordre.titre}</h1>
	<p class="mt-1 text-sm text-neutral-500">
		par {data.ordre.auteur.nom} · {dateCourte(data.ordre.creeLe)}
		{#if data.ordre.forkDe}
			· parti de
			<a
				href={resolve('/order/[id]', { id: data.ordre.forkDe.id })}
				class="underline underline-offset-4">{data.ordre.forkDe.titre}</a
			>
		{/if}
	</p>

	{#if data.ordre.description}
		<p class="mt-4 text-sm whitespace-pre-line text-neutral-700">{data.ordre.description}</p>
	{/if}

	{#if form?.message}
		<p class="mt-4 text-sm text-red-600">{form.message}</p>
	{/if}

	<!-- R19, R20 — la progression du membre connecté, dérivée de ses œuvres
	     atteintes et de rien d'autre. -->
	<section class="mt-8 rounded-md border border-neutral-300 bg-neutral-50 p-4">
		<p class="text-sm">
			<span class="font-medium">{avancement(data.progression.pourcentage)}</span>
			<span class="text-neutral-500">
				· {data.progression.essentiellesAtteintes} sur {data.progression.essentielles} entrée{data
					.progression.essentielles > 1
					? 's'
					: ''} essentielle{data.progression.essentielles > 1 ? 's' : ''}
				{#if data.progression.total !== data.progression.essentielles}
					· {data.progression.total} entrées en tout
				{/if}
			</span>
		</p>

		{#if suivante}
			<p class="mt-2 text-sm">
				<span class="text-neutral-500">À suivre :</span>
				{#if suivante.oeuvre}
					<a
						href={resolve('/work/[id]', { id: suivante.oeuvre.id })}
						class="font-medium underline underline-offset-4">{suivante.oeuvre.titre}</a
					>
				{:else}
					<span class="text-neutral-400 italic">une œuvre disparue du catalogue</span>
				{/if}
			</p>
		{:else if data.progression.essentielles > 0}
			<p class="mt-2 text-sm text-neutral-500">Tout est atteint. Il n’y a plus rien à suivre.</p>
		{:else}
			<p class="mt-2 text-sm text-neutral-500">
				Aucune entrée essentielle : cet ordre ne mesure rien.
			</p>
		{/if}

		<div class="mt-4 flex flex-wrap items-center gap-4">
			{#if data.ordre.suivi}
				<form method="POST" action="?/cesserDeSuivre">
					<button class="text-sm text-neutral-500 underline underline-offset-4">
						Cesser de suivre
					</button>
				</form>
				<span class="text-xs text-neutral-400">
					Cesser de suivre ne fait rien perdre : tes consignations restent, et ta progression
					revient telle quelle si tu le reprends.
				</span>
			{:else}
				<form method="POST" action="?/suivre">
					<button
						class="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700"
					>
						Suivre cet ordre
					</button>
				</form>
			{/if}

			<form method="POST" action="?/forker">
				<button class="text-sm underline underline-offset-4">Le forker</button>
			</form>
		</div>
	</section>

	<!-- R22 — combien de membres le suivent, et où ils en sont. -->
	<h2 class="mt-10 text-sm font-semibold tracking-tight">
		Qui le suit ({data.ordre.nombreDeSuiveurs})
	</h2>
	{#if data.suiveurs.length === 0}
		<p class="mt-2 text-sm text-neutral-500">Personne encore.</p>
	{:else}
		<ul class="mt-2 divide-y divide-neutral-200">
			{#each data.suiveurs as suiveur (suiveur.membreId)}
				<li class="flex items-baseline justify-between gap-4 py-2 text-sm">
					<a
						href={resolve('/member/[id]', { id: suiveur.membreId })}
						class="font-medium underline underline-offset-4">{suiveur.nom}</a
					>
					<span class="text-neutral-500">{avancement(suiveur.pourcentage)}</span>
				</li>
			{/each}
		</ul>
	{/if}

	<!-- La séquence, en lecture pour tout le monde. -->
	{#if !data.ordre.modifiable}
		<h2 class="mt-10 text-sm font-semibold tracking-tight">
			La séquence ({data.entrees.length})
		</h2>
		{#if data.entrees.length === 0}
			<p class="mt-2 text-sm text-neutral-500">Cet ordre est encore vide.</p>
		{:else}
			<ol class="mt-2 divide-y divide-neutral-200">
				{#each data.entrees as entree (entree.id)}
					<li class="flex items-baseline justify-between gap-4 py-2 text-sm">
						<span>
							<span class="text-neutral-400">{entree.rang + 1}.</span>
							{#if entree.oeuvre}
								<a
									href={resolve('/work/[id]', { id: entree.oeuvre.id })}
									class="font-medium underline underline-offset-4">{entree.oeuvre.titre}</a
								>
							{:else}
								<span class="text-neutral-400 italic">Œuvre disparue du catalogue</span>
							{/if}
							{#if entree.facultative}
								<span class="text-neutral-500">· facultative</span>
							{/if}
						</span>
						{#if entree.atteinte}
							<span class="whitespace-nowrap text-neutral-500">atteinte</span>
						{/if}
					</li>
				{/each}
			</ol>
		{/if}
	{:else}
		<!-- R16 — l'éditeur n'existe que pour l'auteur. Le refus est aussi vérifié
		     côté serveur : cacher le formulaire n'est pas une autorisation. -->
		<h2 class="mt-12 text-sm font-semibold tracking-tight">Le titre</h2>
		<form method="POST" action="?/modifier" class="mt-2 flex flex-col gap-2">
			<input
				name="titre"
				value={data.ordre.titre}
				class="rounded-md border border-neutral-300 px-3 py-2 text-sm"
			/>
			<textarea
				name="description"
				rows="3"
				placeholder="À qui s’adresse cet ordre, et pourquoi celui-là."
				class="rounded-md border border-neutral-300 px-3 py-2 text-sm"
				>{data.ordre.description}</textarea
			>
			<div class="flex items-center gap-4">
				<button class="rounded-md border border-neutral-300 px-3 py-1.5 text-sm font-medium">
					Enregistrer
				</button>
				<span class="text-xs text-neutral-400">
					Un titre d’ordre est du texte libre : il peut gâcher quelque chose à qui le lit.
				</span>
			</div>
		</form>

		<OrderEditor
			entrees={data.entrees}
			requete={data.requete}
			resultats={data.resultats}
			series={data.series}
		/>

		<form method="POST" action="?/supprimer" class="mt-12">
			<button class="text-sm text-red-600 underline underline-offset-4">
				Supprimer cet ordre
			</button>
			<span class="ml-2 text-xs text-neutral-400">
				Ses suiveurs le perdent ; leurs consignations, non. Les forks qui en sont partis survivent.
			</span>
		</form>
	{/if}
</main>
