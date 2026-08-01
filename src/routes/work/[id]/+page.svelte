<script lang="ts">
	import { resolve } from '$app/paths';
	import MaskedText from '$lib/components/MaskedText.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	/** La note en étoiles, demi-étoiles comprises (R4). */
	function etoiles(note: number): string {
		return '★'.repeat(Math.floor(note)) + (note % 1 === 0.5 ? '½' : '');
	}

	const pourcentage = (position: number) => `${Math.round(position * 100)} %`;

	/** R26 — qui l’a atteinte, et qui est en route. */
	const arrives = $derived(data.lecteurs.filter((lecteur) => lecteur.atteinte));
	const enRoute = $derived(
		data.lecteurs.filter((lecteur) => !lecteur.atteinte && lecteur.etagere === 'en_cours')
	);

	/**
	 * Les trois étagères de R1, et rien de plus.
	 *
	 * L’abandon n’est pas dans cette liste et ne doit jamais y entrer : R2 en fait
	 * un état distinct des trois, et une quatrième case au même niveau le
	 * transformerait en étagère sous les yeux du membre.
	 */
	const ETAGERES = [
		{ valeur: 'a_decouvrir', libelle: 'À découvrir' },
		{ valeur: 'en_cours', libelle: 'En cours' },
		{ valeur: 'termine', libelle: 'Terminé' }
	] as const;

	/** Les dix notes de R4 : de 0,5 à 5 par demi-étoiles. */
	const NOTES = Array.from({ length: 10 }, (_, index) => (index + 1) / 2);

	const nombreFr = (valeur: number) => valeur.toString().replace('.', ',');

	/** R23 — la position ne se déclare que là où elle a un sens, et où elle en a encore. */
	const positionUtile = $derived(data.oeuvre.longue && data.moi.consignee && !data.moi.atteinte);

	/**
	 * Le texte déjà écrit, prérempli — il est passé par `masquer` comme les autres.
	 *
	 * Un avis refusé rend la saisie avec le refus : R25 se rencontre en écrivant, et
	 * perdre le texte serait punir deux fois.
	 */
	const monTexte = $derived(
		form && 'texte' in form && typeof form.texte === 'string'
			? form.texte
			: (data.moi.avis?.texte ?? '')
	);
</script>

<svelte:head><title>{data.oeuvre.titre} — readerbox</title></svelte:head>

<main class="mx-auto max-w-2xl px-6 py-16">
	<a href={resolve('/')} class="text-sm text-neutral-500 underline underline-offset-4">Retour</a>

	<div class="mt-6 flex gap-6">
		{#if data.oeuvre.couvertureUrl}
			<img
				src={data.oeuvre.couvertureUrl}
				alt=""
				class="h-40 w-28 shrink-0 rounded-sm border border-neutral-200 object-cover"
			/>
		{/if}

		<div class="min-w-0">
			<!-- Le titre vient d’une source tierce : interpolé, donc littéral. -->
			<h1 class="text-2xl font-semibold tracking-tight">{data.oeuvre.titre}</h1>
			<p class="mt-1 text-sm text-neutral-500">
				{data.oeuvre.type}
				{#if data.oeuvre.serie}
					·
					{#if data.oeuvre.serieFacette}
						<a
							href={resolve('/parcours/[axe]/[source]/[id]', {
								axe: 'serie',
								source: data.oeuvre.serieFacette.source,
								id: data.oeuvre.serieFacette.idExterne
							})}
							class="underline underline-offset-4">{data.oeuvre.serie}</a
						>
					{:else}{data.oeuvre.serie}{/if}
				{/if}
				{#if data.oeuvre.numeroDansLaSerie !== null}· n° {data.oeuvre.numeroDansLaSerie}{/if}
				{#if data.oeuvre.dateDeParution}· {data.oeuvre.dateDeParution}{/if}
			</p>

			{#if data.oeuvre.event}
				<p class="mt-1 text-sm text-neutral-500">
					{#if data.oeuvre.eventFacette}
						<a
							href={resolve('/parcours/[axe]/[source]/[id]', {
								axe: 'event',
								source: data.oeuvre.eventFacette.source,
								id: data.oeuvre.eventFacette.idExterne
							})}
							class="underline underline-offset-4">{data.oeuvre.event}</a
						>
					{:else}{data.oeuvre.event}{/if}
				</p>
			{/if}

			<!-- Une fiche incomplète le dit : c’est ce que l’état d’ingestion existe pour porter. -->
			{#if data.oeuvre.etatIngestion !== 'complete'}
				<p class="mt-1 text-xs text-neutral-400">
					La source n’a pas tout donné pour cette fiche. Elle se complétera d’elle-même.
				</p>
			{/if}
		</div>
	</div>

	<!-- R46 — chaque personnage est une porte vers ses autres apparitions, consignées ou non. -->
	{#if data.personnages.length > 0}
		<p class="mt-4 text-sm text-neutral-700">
			<span class="text-neutral-500">Personnages :</span>
			{#each data.personnages as personnage, index (personnage.entityId)}{#if index > 0},
				{/if}{#if personnage.facette}<a
						href={resolve('/parcours/[axe]/[source]/[id]', {
							axe: 'personnage',
							source: personnage.facette.source,
							id: personnage.facette.idExterne
						})}
						class="underline underline-offset-4">{personnage.nom}</a
					>{:else}{personnage.nom}{/if}{/each}
		</p>
	{/if}

	<!-- R28 — l’agrégat ne passe jamais par le masquage. -->
	<p class="mt-4 text-sm">
		{#if data.agregat.noteMoyenne !== null}
			<span class="font-medium">{etoiles(data.agregat.noteMoyenne)}</span>
			<span class="text-neutral-500">
				{data.agregat.noteMoyenne.toFixed(1)} · {data.agregat.nombreDeNotes} note{data.agregat
					.nombreDeNotes > 1
					? 's'
					: ''}
			</span>
		{:else}
			<span class="text-neutral-500">Personne du groupe ne l’a encore notée.</span>
		{/if}
		<span class="text-neutral-500">
			· {data.agregat.nombreDAvis} avis
		</span>
	</p>

	{#if form?.message}
		<p class="mt-4 rounded-md border border-neutral-300 bg-neutral-50 p-3 text-sm text-neutral-700">
			{form.message}
		</p>
	{/if}

	<!-- ------------------------------------------------------------------ -->
	<!-- Où j’en suis : la boucle centrale du produit.                       -->
	<!-- ------------------------------------------------------------------ -->
	<section class="mt-8 rounded-md border border-neutral-300 bg-neutral-50 p-4">
		<h2 class="text-sm font-semibold tracking-tight">Où tu en es</h2>

		<p class="mt-1 text-sm text-neutral-500">
			{#if !data.moi.consignee}
				Tu n’as pas encore posé cette œuvre sur une étagère.
			{:else if data.moi.abandonnee}
				Abandonnée — l’œuvre est atteinte, et les avis du groupe te sont ouverts.
			{:else if data.moi.etagere === 'termine'}
				Terminée — l’œuvre est atteinte.
			{:else if data.moi.etagere === 'en_cours'}
				En cours{#if data.moi.position > 0}, à {pourcentage(data.moi.position)}{/if}.
			{:else}
				À découvrir — rien ne t’en sera dit tant que tu ne l’auras pas atteinte.
			{/if}
		</p>

		{#if data.provenance}
			<!-- R42 — annoncée seulement si l’ordre existe et contient bien l’œuvre. -->
			<p class="mt-1 text-xs text-neutral-400">
				{data.provenance.enregistree ? 'Consignée depuis l’ordre' : 'Tu arrives depuis l’ordre'}
				<a
					href={resolve('/order/[id]', { id: data.provenance.ordreId })}
					class="underline underline-offset-4">{data.provenance.titre}</a
				>{#if !data.provenance.enregistree}. Ta consignation s’en souviendra{/if}.
			</p>
		{/if}

		<!-- R1 — les trois étagères, et seulement elles. -->
		<div class="mt-3 flex flex-wrap gap-2">
			{#each ETAGERES as etagere (etagere.valeur)}
				<form method="POST" action="?/consigner">
					<input type="hidden" name="etagere" value={etagere.valeur} />
					{#if data.provenance}
						<input type="hidden" name="depuis" value={data.provenance.ordreId} />
					{/if}
					<button
						class="rounded-md border px-3 py-1.5 text-sm font-medium {data.moi.etagere ===
							etagere.valeur && !data.moi.abandonnee
							? 'border-neutral-900 bg-neutral-900 text-white'
							: 'border-neutral-300 bg-white hover:bg-neutral-100'}"
					>
						{etagere.libelle}
					</button>
				</form>
			{/each}
		</div>

		{#if data.moi.consignee}
			<!-- R2, R35 — l’abandon est une action à part, pas une quatrième étagère. -->
			<div class="mt-3 flex flex-wrap items-center gap-4">
				{#if data.moi.abandonnee}
					<form method="POST" action="?/reprendre">
						<button class="text-sm underline underline-offset-4">Reprendre ma lecture</button>
					</form>
					<span class="text-xs text-neutral-400">
						Reprendre te remet en cours : l’œuvre cesse d’être atteinte, et ses avis se referment.
					</span>
				{:else}
					<form method="POST" action="?/abandonner">
						<button class="text-sm underline underline-offset-4">Abandonner</button>
					</form>
					<span class="text-xs text-neutral-400">
						Abandonner atteint l’œuvre sans exiger de note ni d’avis.
					</span>
				{/if}
			</div>

			<form method="POST" action="?/retirer" class="mt-3">
				<button class="text-sm text-red-600 underline underline-offset-4">
					Retirer ma consignation
				</button>
				<span class="ml-2 text-xs text-neutral-400">
					Ta note et ton avis partent avec elle.{#if data.moi.recueils > 0}
						L’œuvre restera dans ton journal : un recueil que tu lis la contient.{/if}
				</span>
			</form>
		{/if}
	</section>

	<!-- R23 — la position, en page ou en pourcentage. -->
	{#if positionUtile}
		<section class="mt-6">
			<h2 class="text-sm font-semibold tracking-tight">Où tu en es dans l’œuvre</h2>
			<form method="POST" action="?/position" class="mt-2 flex flex-wrap items-center gap-2">
				<input
					name="valeur"
					inputmode="decimal"
					placeholder="30"
					class="w-24 rounded-md border border-neutral-300 px-3 py-1.5 text-sm"
				/>
				<select name="unite" class="rounded-md border border-neutral-300 px-3 py-1.5 text-sm">
					<option value="pourcentage">% de l’œuvre</option>
					<option value="page">page</option>
				</select>
				<input
					name="longueur"
					inputmode="numeric"
					placeholder={data.moi.longueurTotale === null
						? 'pages en tout'
						: String(data.moi.longueurTotale)}
					class="w-32 rounded-md border border-neutral-300 px-3 py-1.5 text-sm"
				/>
				<button
					class="rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm font-medium"
				>
					Déclarer
				</button>
			</form>
			<p class="mt-1 text-xs text-neutral-400">
				Une page n’a de sens qu’avec le nombre de pages de ton édition : deux membres ne lisent pas
				la même. La position est enregistrée en fraction de l’œuvre, pour être comparable.
			</p>
		</section>
	{/if}

	<!-- R4 — la note, indépendante de l’avis. -->
	{#if data.moi.consignee}
		<section class="mt-6">
			<h2 class="text-sm font-semibold tracking-tight">
				Ta note
				{#if data.moi.note !== null}
					<span class="font-normal text-neutral-500">— {etoiles(data.moi.note)}</span>
				{/if}
			</h2>
			<form method="POST" action="?/noter" class="mt-2 flex flex-wrap gap-1">
				{#each NOTES as note (note)}
					<button
						name="note"
						value={note}
						title="{nombreFr(note)} étoile{note > 1 ? 's' : ''}"
						class="w-10 rounded-md border px-1 py-1 text-xs {data.moi.note === note
							? 'border-neutral-900 bg-neutral-900 text-white'
							: 'border-neutral-300 bg-white hover:bg-neutral-100'}"
					>
						{nombreFr(note)}
					</button>
				{/each}
			</form>
			{#if data.moi.note !== null}
				<form method="POST" action="?/retirerNote" class="mt-2">
					<button class="text-sm text-neutral-500 underline underline-offset-4">
						Retirer ma note
					</button>
				</form>
			{/if}
		</section>
	{/if}

	<!-- R5, R25, R37 — l’avis. -->
	{#if data.moi.consignee}
		<section class="mt-6">
			<h2 class="text-sm font-semibold tracking-tight">Ton avis</h2>

			{#if !data.moi.publicationPossible && data.moi.avis === null}
				<p class="mt-2 text-sm text-neutral-500">
					Cette œuvre est longue et tu ne l’as pas atteinte : déclare d’abord où tu en es. Ton avis
					ne sera servi qu’à ceux qui sont allés aussi loin que toi — c’est à ça que sert la
					position.
				</p>
			{/if}

			<form
				method="POST"
				action={data.moi.avis === null ? '?/ecrireAvis' : '?/modifierAvis'}
				class="mt-2 flex flex-col gap-2"
			>
				<textarea
					name="texte"
					rows="4"
					placeholder="Ce que tu en as pensé."
					class="rounded-md border border-neutral-300 px-3 py-2 text-sm">{monTexte}</textarea
				>
				<div class="flex items-center gap-4">
					<button class="rounded-md border border-neutral-300 px-3 py-1.5 text-sm font-medium">
						{data.moi.avis === null ? 'Publier' : 'Enregistrer'}
					</button>
					<span class="text-xs text-neutral-400">
						Ton avis est masqué pour qui n’a pas atteint l’œuvre.
					</span>
				</div>
			</form>

			{#if data.moi.avis !== null}
				<form method="POST" action="?/supprimerAvis" class="mt-2">
					<button class="text-sm text-red-600 underline underline-offset-4">
						Supprimer mon avis
					</button>
					<span class="ml-2 text-xs text-neutral-400"> Ta consignation et ta note restent. </span>
				</form>
			{/if}
		</section>
	{/if}

	{#if arrives.length > 0 || enRoute.length > 0}
		<h2 class="mt-10 text-sm font-semibold tracking-tight">Le groupe</h2>
		<ul class="mt-2 text-sm text-neutral-700">
			{#if arrives.length > 0}
				<li>
					<span class="text-neutral-500">L’ont atteinte :</span>
					{arrives.map((lecteur) => lecteur.nom ?? 'un membre parti').join(', ')}
				</li>
			{/if}
			{#each enRoute as lecteur (lecteur.membreId)}
				<li>
					<span class="text-neutral-500">En cours :</span>
					{lecteur.nom ?? 'un membre parti'}
					{#if lecteur.position > 0}· {pourcentage(lecteur.position)}{/if}
				</li>
			{/each}
		</ul>
	{/if}

	<h2 class="mt-10 text-sm font-semibold tracking-tight">Avis</h2>

	{#if data.avis.length === 0}
		<p class="mt-2 text-sm text-neutral-500">Personne n’a encore écrit.</p>
	{:else}
		<div class="mt-2 divide-y divide-neutral-200">
			{#each data.avis as avis (avis.id)}
				<MaskedText
					oeuvreId={avis.oeuvreId}
					auteur={avis.mien ? 'Toi' : avis.auteur.nom}
					note={avis.note}
					ecritLe={avis.ecritLe}
					masque={avis.masque}
					texte={avis.texte}
				/>
			{/each}
		</div>
	{/if}
</main>
