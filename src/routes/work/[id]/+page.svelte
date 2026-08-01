<script lang="ts">
	import { resolve } from '$app/paths';
	import Etoiles from '$lib/components/Etoiles.svelte';
	import MaskedText from '$lib/components/MaskedText.svelte';
	import { ETAGERES_AFFICHEES } from '$lib/affichage';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const pourcentage = (position: number) => `${Math.round(position * 100)} %`;

	/** R26 — qui l’a atteinte, et qui est en route. */
	const arrives = $derived(data.lecteurs.filter((lecteur) => lecteur.atteinte));
	const enRoute = $derived(
		data.lecteurs.filter((lecteur) => !lecteur.atteinte && lecteur.etagere === 'en_cours')
	);

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

	/**
	 * La page revient-elle d’une révélation ? Mouvement 3 — les textes qui
	 * viennent de s’ouvrir se découvrent alors d’un coup.
	 *
	 * La révélation vaut pour un membre sur une œuvre, donc pour **tous** les
	 * avis de cette page à la fois : le mur tombe d’un bloc, et c’est bien ce
	 * qu’il s’est passé.
	 */
	const revele = $derived(form !== null && 'revele' in form && form.revele === true);

	/** La ligne de situation sous le titre, telle que la source la donne. */
	const situation = $derived(
		[
			data.oeuvre.type,
			data.oeuvre.numeroDansLaSerie === null ? null : `n° ${data.oeuvre.numeroDansLaSerie}`,
			data.oeuvre.dateDeParution
		]
			.filter((morceau): morceau is string => Boolean(morceau))
			.join(' · ')
	);
</script>

<svelte:head><title>{data.oeuvre.titre} — readerbox</title></svelte:head>

<main class="mx-auto w-full max-w-4xl flex-1 px-5 py-10">
	<!-- ---------------------------------------------------------------- -->
	<!-- La couverture, en grand : c’est elle qu’on vient voir.            -->
	<!-- ---------------------------------------------------------------- -->
	<div class="flex flex-col gap-8 sm:flex-row">
		<div class="w-40 shrink-0 sm:w-56">
			<div
				class="relative aspect-[2/3] w-full overflow-hidden bg-cimaise
					{data.moi.atteinte
					? 'outline-2 outline-or'
					: data.moi.consignee
						? 'outline-1 outline-or-sourd'
						: ''}"
			>
				<!-- Le titre sous la couverture : une adresse d’image morte ne laisse
				     pas un rectangle gris. -->
				<p
					class="absolute inset-0 flex items-end p-3 font-display text-base leading-tight
						text-encre-tenue uppercase"
				>
					{data.oeuvre.titre}
				</p>
				{#if data.oeuvre.couvertureUrl}
					<img src={data.oeuvre.couvertureUrl} alt="" class="relative h-full w-full object-cover" />
				{/if}
			</div>
		</div>

		<div class="min-w-0 flex-1">
			<p class="enseigne">{situation}</p>

			<!-- Le titre vient d’une source tierce : interpolé, donc littéral. -->
			<h1 class="mt-1 font-display text-3xl leading-none tracking-tight sm:text-4xl">
				{data.oeuvre.titre}
			</h1>

			<p class="mt-2 text-sm text-encre-basse">
				{#if data.oeuvre.serie}
					{#if data.oeuvre.serieFacette}
						<a
							href={resolve('/parcours/[axe]/[source]/[id]', {
								axe: 'serie',
								source: data.oeuvre.serieFacette.source,
								id: data.oeuvre.serieFacette.idExterne
							})}
							class="lien">{data.oeuvre.serie}</a
						>
					{:else}{data.oeuvre.serie}{/if}
				{/if}
				{#if data.oeuvre.event}
					{#if data.oeuvre.serie}·{/if}
					{#if data.oeuvre.eventFacette}
						<a
							href={resolve('/parcours/[axe]/[source]/[id]', {
								axe: 'event',
								source: data.oeuvre.eventFacette.source,
								id: data.oeuvre.eventFacette.idExterne
							})}
							class="lien">{data.oeuvre.event}</a
						>
					{:else}{data.oeuvre.event}{/if}
				{/if}
			</p>

			<!-- R28 — l’agrégat ne passe jamais par le masquage. Il se lit en un
			     glyphe : la note du groupe est ce qu’on vient chercher avant. -->
			<div class="mt-6 flex items-end gap-4 border-t border-trait pt-4">
				{#if data.agregat.noteMoyenne !== null}
					<p class="font-display text-5xl leading-none text-or tabular-nums">
						{data.agregat.noteMoyenne.toFixed(1).replace('.', ',')}
					</p>
					<p class="text-xs text-encre-tenue">
						<span class="block text-base"><Etoiles valeur={data.agregat.noteMoyenne} /></span>
						<span class="mt-1 block">
							{data.agregat.nombreDeNotes} note{data.agregat.nombreDeNotes > 1 ? 's' : ''} · {data
								.agregat.nombreDAvis} avis
						</span>
					</p>
				{:else}
					<p class="text-sm text-encre-tenue">
						Personne du groupe ne l’a encore notée.
						{#if data.agregat.nombreDAvis > 0}
							{data.agregat.nombreDAvis} avis.
						{/if}
					</p>
				{/if}
			</div>

			<!-- R46 — chaque personnage est une porte vers ses autres apparitions. -->
			{#if data.personnages.length > 0}
				<p class="mt-4 text-sm text-encre-basse">
					<span class="text-encre-tenue">Personnages :</span>
					{#each data.personnages as personnage, index (personnage.entityId)}{#if index > 0}<span
								>,&nbsp;</span
							>{/if}{#if personnage.facette}<a
								href={resolve('/parcours/[axe]/[source]/[id]', {
									axe: 'personnage',
									source: personnage.facette.source,
									id: personnage.facette.idExterne
								})}
								class="lien">{personnage.nom}</a
							>{:else}{personnage.nom}{/if}{/each}
				</p>
			{/if}

			<!-- Une fiche incomplète le dit : c’est ce que l’état d’ingestion existe pour porter. -->
			{#if data.oeuvre.etatIngestion !== 'complete'}
				<p class="mt-3 text-xs text-encre-tenue">
					La source n’a pas tout donné pour cette fiche. Elle se complétera d’elle-même.
				</p>
			{/if}
		</div>
	</div>

	{#if form?.message}
		<p class="mt-8 border-l-2 border-trait bg-cimaise px-4 py-3 text-sm text-encre-basse">
			{form.message}
		</p>
	{/if}

	<!-- ------------------------------------------------------------------ -->
	<!-- Où j’en suis : la boucle centrale du produit.                       -->
	<!--                                                                     -->
	<!-- Consigner, c’est poser sur une étagère ; atteindre, c’est avoir      -->
	<!-- terminé ou abandonné. La bande d’état dit lequel des deux, en toutes -->
	<!-- lettres, et c’est l’or qui porte la différence.                      -->
	<!-- ------------------------------------------------------------------ -->
	<section class="mt-12">
		<h2 class="enseigne">Où tu en es</h2>

		<div
			class="mt-3 border-l-2 py-2 pl-4
				{data.moi.atteinte ? 'border-or' : data.moi.consignee ? 'border-or-sourd' : 'border-trait'}"
		>
			<p
				class="font-display text-xl leading-none tracking-wide uppercase
					{data.moi.atteinte ? 'text-or' : 'text-encre'}"
			>
				{#if !data.moi.consignee}
					Sur aucune étagère
				{:else if data.moi.abandonnee}
					Atteinte — abandonnée
				{:else if data.moi.etagere === 'termine'}
					Atteinte — terminée
				{:else if data.moi.etagere === 'en_cours'}
					Consignée — en cours{#if data.moi.position > 0}, à {pourcentage(data.moi.position)}{/if}
				{:else}
					Consignée — à découvrir
				{/if}
			</p>
			<p class="mt-1 text-sm text-encre-tenue">
				{#if !data.moi.consignee}
					Pose-la quelque part pour en garder la trace. Seule l’atteinte ouvre les avis du groupe.
				{:else if data.moi.atteinte}
					Les avis du groupe te sont ouverts, tes ordres ont avancé, et ton graphe s’est étendu.
				{:else}
					Consignée n’est pas atteinte : les avis du groupe restent fermés tant que tu ne l’as pas
					terminée ou abandonnée.
				{/if}
			</p>
		</div>

		{#if data.provenance}
			<!-- R42 — annoncée seulement si l’ordre existe et contient bien l’œuvre. -->
			<p class="mt-3 text-xs text-encre-tenue">
				{data.provenance.enregistree ? 'Consignée depuis l’ordre' : 'Tu arrives depuis l’ordre'}
				<a href={resolve('/order/[id]', { id: data.provenance.ordreId })} class="lien"
					>{data.provenance.titre}</a
				>{#if !data.provenance.enregistree}. Ta consignation s’en souviendra{/if}.
			</p>
		{/if}

		<!-- R1 — les trois étagères, et seulement elles. -->
		<div class="mt-4 flex flex-wrap gap-2">
			{#each ETAGERES_AFFICHEES as etagere (etagere.valeur)}
				<form method="POST" action="?/consigner">
					<input type="hidden" name="etagere" value={etagere.valeur} />
					{#if data.provenance}
						<input type="hidden" name="depuis" value={data.provenance.ordreId} />
					{/if}
					<button
						class="action-sourde"
						data-retenu={data.moi.etagere === etagere.valeur && !data.moi.abandonnee
							? 'oui'
							: undefined}
					>
						{etagere.libelle}
					</button>
				</form>
			{/each}
		</div>

		{#if data.moi.consignee}
			<!-- R2, R35 — l’abandon est une action à part, pas une quatrième étagère. -->
			<div class="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2">
				{#if data.moi.abandonnee}
					<form method="POST" action="?/reprendre">
						<button class="lien text-sm">Reprendre ma lecture</button>
					</form>
					<span class="text-xs text-encre-tenue">
						Reprendre te remet en cours : l’œuvre cesse d’être atteinte, et ses avis se referment.
					</span>
				{:else}
					<form method="POST" action="?/abandonner">
						<button class="lien text-sm">Abandonner</button>
					</form>
					<span class="text-xs text-encre-tenue">
						Abandonner atteint l’œuvre sans exiger de note ni d’avis.
					</span>
				{/if}
			</div>

			<form method="POST" action="?/retirer" class="mt-3">
				<button class="risque text-sm">Retirer ma consignation</button>
				<span class="ml-2 text-xs text-encre-tenue">
					Ta note et ton avis partent avec elle.{#if data.moi.recueils > 0}
						L’œuvre restera dans ton journal : un recueil que tu lis la contient.{/if}
				</span>
			</form>
		{/if}
	</section>

	<!-- R23 — la position, en page ou en pourcentage. -->
	{#if positionUtile}
		<section class="mt-10">
			<h2 class="enseigne">Où tu en es dans l’œuvre</h2>
			<form method="POST" action="?/position" class="mt-3 flex flex-wrap items-center gap-2">
				<label>
					<span class="sr-only">Avancement</span>
					<input name="valeur" inputmode="decimal" placeholder="30" class="champ w-24" />
				</label>
				<label>
					<span class="sr-only">Unité</span>
					<select name="unite" class="champ">
						<option value="pourcentage">% de l’œuvre</option>
						<option value="page">page</option>
					</select>
				</label>
				<label>
					<span class="sr-only">Longueur totale</span>
					<input
						name="longueur"
						inputmode="numeric"
						placeholder={data.moi.longueurTotale === null
							? 'pages en tout'
							: String(data.moi.longueurTotale)}
						class="champ w-32"
					/>
				</label>
				<button class="action-sourde">Déclarer</button>
			</form>
			<p class="mt-2 max-w-2xl text-xs leading-relaxed text-encre-tenue">
				Une page n’a de sens qu’avec le nombre de pages de ton édition : deux membres ne lisent pas
				la même. La position est enregistrée en fraction de l’œuvre, pour être comparable.
			</p>
		</section>
	{/if}

	<!-- R4 — la note, indépendante de l’avis. -->
	{#if data.moi.consignee}
		<section class="mt-10">
			<h2 class="enseigne">
				Ta note
				{#if data.moi.note !== null}
					<span class="ml-2 text-base"><Etoiles valeur={data.moi.note} /></span>
				{/if}
			</h2>
			<form method="POST" action="?/noter" class="mt-3 flex flex-wrap gap-1">
				{#each NOTES as note (note)}
					<button
						name="note"
						value={note}
						title="{nombreFr(note)} étoile{note > 1 ? 's' : ''}"
						data-retenu={data.moi.note === note ? 'oui' : undefined}
						class="action-sourde w-11 justify-center tabular-nums"
					>
						{nombreFr(note)}
					</button>
				{/each}
			</form>
			{#if data.moi.note !== null}
				<form method="POST" action="?/retirerNote" class="mt-3">
					<button class="lien text-sm text-encre-tenue">Retirer ma note</button>
				</form>
			{/if}
		</section>
	{/if}

	<!-- R5, R25, R37 — l’avis. -->
	{#if data.moi.consignee}
		<section class="mt-10 max-w-2xl">
			<h2 class="enseigne">Ton avis</h2>

			{#if !data.moi.publicationPossible && data.moi.avis === null}
				<p class="mt-3 text-sm leading-relaxed text-encre-basse">
					Cette œuvre est longue et tu ne l’as pas atteinte : déclare d’abord où tu en es. Ton avis
					ne sera servi qu’à ceux qui sont allés aussi loin que toi — c’est à ça que sert la
					position.
				</p>
			{/if}

			<form
				method="POST"
				action={data.moi.avis === null ? '?/ecrireAvis' : '?/modifierAvis'}
				class="mt-3 flex flex-col gap-3"
			>
				<label>
					<span class="sr-only">Ton avis</span>
					<textarea
						name="texte"
						rows="5"
						placeholder="Ce que tu en as pensé."
						class="champ w-full leading-relaxed">{monTexte}</textarea
					>
				</label>
				<div class="flex flex-wrap items-center gap-4">
					<button class="action-sourde">
						{data.moi.avis === null ? 'Publier' : 'Enregistrer'}
					</button>
					<span class="text-xs text-encre-tenue">
						Ton avis est masqué pour qui n’a pas atteint l’œuvre.
					</span>
				</div>
			</form>

			{#if data.moi.avis !== null}
				<form method="POST" action="?/supprimerAvis" class="mt-3">
					<button class="risque text-sm">Supprimer mon avis</button>
					<span class="ml-2 text-xs text-encre-tenue">Ta consignation et ta note restent.</span>
				</form>
			{/if}
		</section>
	{/if}

	{#if arrives.length > 0 || enRoute.length > 0}
		<section class="mt-12">
			<h2 class="enseigne">Le groupe</h2>
			<ul class="mt-3 space-y-1 text-sm">
				{#if arrives.length > 0}
					<li>
						<span class="font-display tracking-wide text-or uppercase">L’ont atteinte</span>
						<span class="text-encre-basse">
							· {arrives.map((lecteur) => lecteur.nom ?? 'un membre parti').join(', ')}
						</span>
					</li>
				{/if}
				{#each enRoute as lecteur (lecteur.membreId)}
					<li class="text-encre-basse">
						<span class="text-encre-tenue">En cours :</span>
						{lecteur.nom ?? 'un membre parti'}
						{#if lecteur.position > 0}· {pourcentage(lecteur.position)}{/if}
					</li>
				{/each}
			</ul>
		</section>
	{/if}

	<section class="mt-12 max-w-2xl">
		<h2 class="enseigne">Avis ({data.agregat.nombreDAvis})</h2>

		{#if data.avis.length === 0}
			<p class="mt-3 text-sm text-encre-tenue">Personne n’a encore écrit.</p>
		{:else}
			<div class="mt-2 divide-y divide-trait border-t border-trait">
				{#each data.avis as avis (avis.id)}
					<MaskedText
						oeuvreId={avis.oeuvreId}
						auteur={avis.mien ? 'Toi' : avis.auteur.nom}
						note={avis.note}
						ecritLe={avis.ecritLe}
						masque={avis.masque}
						texte={avis.texte}
						{revele}
					/>
				{/each}
			</div>
		{/if}
	</section>
</main>
