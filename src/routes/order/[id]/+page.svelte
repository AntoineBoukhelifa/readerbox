<script lang="ts">
	import { resolve } from '$app/paths';
	import Affiche from '$lib/components/Affiche.svelte';
	import Grille from '$lib/components/Grille.svelte';
	import Jauge from '$lib/components/Jauge.svelte';
	import OrderEditor from '$lib/components/OrderEditor.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const dateCourte = (ms: number) =>
		new Date(ms).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });

	const suivante = $derived(
		data.progression.entreeSuivante === null
			? null
			: (data.entrees.find((entree) => entree.id === data.progression.entreeSuivante?.id) ?? null)
	);

	/**
	 * R42 — le lien vers une œuvre porte l'ordre d'où il part.
	 *
	 * C'est la seule façon dont la provenance peut se constater : elle est un fait
	 * de navigation, et le serveur ne le devine pas. Le paramètre est forgeable, et
	 * c'est pourquoi la page d'œuvre le revérifie — l'ordre doit exister et
	 * contenir l'œuvre — au chargement comme à l'écriture.
	 */
	const versLOeuvre = (oeuvreId: string) =>
		resolve(`/work/[id]?depuis=${encodeURIComponent(data.ordre.id)}`, { id: oeuvreId });

	/** Le rang, et le fait qu'une entrée soit facultative, sous chaque affiche. */
	const situation = (entree: (typeof data.entrees)[number]) =>
		`${entree.rang + 1}${entree.facultative ? ' · facultative' : ''}`;
</script>

<svelte:head><title>{data.ordre.titre} — readerbox</title></svelte:head>

<main class="mx-auto w-full max-w-5xl flex-1 px-5 py-10">
	<p class="enseigne">Ordre de lecture</p>
	<h1 class="mt-1 font-display text-3xl leading-none tracking-tight sm:text-4xl">
		{data.ordre.titre}
	</h1>
	<p class="mt-2 text-sm text-encre-tenue">
		par {data.ordre.auteur.nom} · {dateCourte(data.ordre.creeLe)}
		{#if data.ordre.forkDe}
			· parti de
			<a href={resolve('/order/[id]', { id: data.ordre.forkDe.id })} class="lien"
				>{data.ordre.forkDe.titre}</a
			>
		{/if}
	</p>

	{#if data.ordre.description}
		<p class="mt-5 max-w-2xl text-sm leading-relaxed whitespace-pre-line text-encre-basse">
			{data.ordre.description}
		</p>
	{/if}

	{#if form?.message}
		<p class="mt-6 border-l-2 border-braise pl-4 text-sm text-encre-basse">{form.message}</p>
	{/if}

	<!-- R19, R20 — la progression du membre connecté, dérivée de ses œuvres
	     atteintes et de rien d'autre. -->
	<section class="mt-10 border-t border-trait pt-6">
		<h2 class="enseigne">Ta progression</h2>

		<div class="mt-3 max-w-md"><Jauge pourcentage={data.progression.pourcentage} /></div>
		<p class="mt-2 text-xs text-encre-tenue">
			{data.progression.essentiellesAtteintes} sur {data.progression.essentielles} entrée{data
				.progression.essentielles > 1
				? 's'
				: ''} essentielle{data.progression.essentielles > 1 ? 's' : ''} atteinte{data.progression
				.essentielles > 1
				? 's'
				: ''}
			{#if data.progression.total !== data.progression.essentielles}
				· {data.progression.total} entrées en tout
			{/if}
		</p>

		{#if suivante}
			<div class="mt-6 flex items-start gap-4">
				<!-- La couverture seule, sans son titre : il est déjà à côté, en grand.
				     Une affiche complète le répéterait deux fois à trois centimètres. -->
				{#if suivante.oeuvre?.couvertureUrl}
					<a href={versLOeuvre(suivante.oeuvre.id)} class="w-24 shrink-0">
						<img
							src={suivante.oeuvre.couvertureUrl}
							alt=""
							class="aspect-[2/3] w-full bg-cimaise object-cover"
						/>
					</a>
				{/if}
				<div class="min-w-0">
					<p class="enseigne">À suivre</p>
					{#if suivante.oeuvre}
						<p class="mt-1">
							<a
								href={versLOeuvre(suivante.oeuvre.id)}
								class="lien font-display text-xl leading-tight">{suivante.oeuvre.titre}</a
							>
						</p>
					{:else}
						<p class="mt-1 text-sm text-encre-tenue italic">une œuvre disparue du catalogue</p>
					{/if}
					<p class="mt-1 text-xs text-encre-tenue">
						La première entrée essentielle que tu n’as pas encore atteinte.
					</p>
				</div>
			</div>
		{:else if data.progression.essentielles > 0}
			<p class="mt-6 font-display text-lg tracking-wide text-or uppercase">
				Tout est atteint. Il n’y a plus rien à suivre.
			</p>
		{:else}
			<p class="mt-6 text-sm text-encre-tenue">
				Aucune entrée essentielle : cet ordre ne mesure rien.
			</p>
		{/if}

		<div class="mt-6 flex flex-wrap items-center gap-x-4 gap-y-3">
			{#if data.ordre.suivi}
				<form method="POST" action="?/cesserDeSuivre">
					<button class="lien text-sm text-encre-tenue">Cesser de suivre</button>
				</form>
				<span class="max-w-md text-xs leading-relaxed text-encre-tenue">
					Cesser de suivre ne fait rien perdre : tes consignations restent, et ta progression
					revient telle quelle si tu le reprends.
				</span>
			{:else}
				<form method="POST" action="?/suivre">
					<button class="action">Suivre cet ordre</button>
				</form>
			{/if}

			<form method="POST" action="?/forker">
				<button class="lien text-sm">Le forker</button>
			</form>
		</div>
	</section>

	<!-- R22 — combien de membres le suivent, et où ils en sont. -->
	<section class="mt-12">
		<h2 class="enseigne">Qui le suit ({data.ordre.nombreDeSuiveurs})</h2>
		{#if data.suiveurs.length === 0}
			<p class="mt-3 text-sm text-encre-tenue">Personne encore.</p>
		{:else}
			<ul class="mt-3 max-w-xl border-t border-trait">
				{#each data.suiveurs as suiveur (suiveur.membreId)}
					<li class="flex items-center justify-between gap-6 border-b border-trait py-2 text-sm">
						<a href={resolve('/member/[id]', { id: suiveur.membreId })} class="lien"
							>{suiveur.nom}</a
						>
						<span class="w-40 shrink-0"><Jauge pourcentage={suiveur.pourcentage} /></span>
					</li>
				{/each}
			</ul>
		{/if}
	</section>

	<!-- La séquence, en lecture pour tout le monde : une grille d'affiches, où
	     ce qui porte le liseré d'or est ce qui est déjà atteint. -->
	{#if !data.ordre.modifiable}
		<section class="mt-12">
			<h2 class="enseigne">La séquence ({data.entrees.length})</h2>
			{#if data.entrees.length === 0}
				<p class="mt-3 text-sm text-encre-tenue">Cet ordre est encore vide.</p>
			{:else}
				<div class="mt-4">
					<Grille serree>
						{#each data.entrees as entree, rang (entree.id)}
							<li>
								{#if entree.oeuvre}
									<Affiche
										titre={entree.oeuvre.titre}
										couvertureUrl={entree.oeuvre.couvertureUrl}
										href={versLOeuvre(entree.oeuvre.id)}
										situation={situation(entree)}
										etat={entree.atteinte ? 'atteint' : 'aucun'}
										{rang}
									/>
								{:else}
									<Affiche
										titre="Œuvre disparue du catalogue"
										situation={situation(entree)}
										{rang}
									/>
								{/if}
							</li>
						{/each}
					</Grille>
				</div>
			{/if}
		</section>
	{:else}
		<!-- R16 — l'éditeur n'existe que pour l'auteur. Le refus est aussi vérifié
		     côté serveur : cacher le formulaire n'est pas une autorisation. -->
		<section class="mt-12 max-w-2xl">
			<h2 class="enseigne">Le titre</h2>
			<form method="POST" action="?/modifier" class="mt-3 flex flex-col gap-3">
				<label>
					<span class="sr-only">Titre de l’ordre</span>
					<input name="titre" value={data.ordre.titre} class="champ w-full" />
				</label>
				<label>
					<span class="sr-only">Description</span>
					<textarea
						name="description"
						rows="3"
						placeholder="À qui s’adresse cet ordre, et pourquoi celui-là."
						class="champ w-full leading-relaxed">{data.ordre.description}</textarea
					>
				</label>
				<div class="flex flex-wrap items-center gap-4">
					<button class="action-sourde">Enregistrer</button>
					<span class="text-xs text-encre-tenue">
						Un titre d’ordre est du texte libre : il peut gâcher quelque chose à qui le lit.
					</span>
				</div>
			</form>
		</section>

		<OrderEditor
			entrees={data.entrees}
			requete={data.requete}
			resultats={data.resultats}
			degradations={data.degradations}
			series={data.series}
		/>

		<form method="POST" action="?/supprimer" class="mt-12">
			<button class="risque text-sm">Supprimer cet ordre</button>
			<span class="ml-2 text-xs text-encre-tenue">
				Ses suiveurs le perdent ; leurs consignations, non. Les forks qui en sont partis survivent.
			</span>
		</form>
	{/if}
</main>
