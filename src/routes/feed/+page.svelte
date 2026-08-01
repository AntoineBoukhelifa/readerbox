<script lang="ts">
	import { resolve } from '$app/paths';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const jour = (ms: number) =>
		new Date(ms).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });

	const etoiles = (note: number) => `${note.toString().replace('.', ',')}/5`;

	const pourcent = (position: number) => `${Math.round(position * 100)} %`;

	type Evenement = PageProps['data']['evenements'][number];

	/**
	 * La phrase d'un événement, coupée autour de ce qu'elle désigne.
	 *
	 * En deux morceaux plutôt qu'en une chaîne, parce que le milieu est parfois un
	 * lien et parfois pas : un titre masqué par R32 ne doit surtout pas être
	 * cliquable — ouvrir la page de l'œuvre le révélerait en un geste, et la règle
	 * n'aurait servi à rien.
	 *
	 * Le libellé du milieu arrive déjà décidé par le serveur : le titre, ou le type
	 * de l'œuvre quand R32 le masque. « Camille a terminé un numéro de comic » se
	 * lit ; « Camille a terminé ??? » donnerait à croire que le produit est cassé.
	 */
	function phrase(evenement: Evenement): { avant: string; apres: string } {
		switch (evenement.type) {
			case 'consignation':
				if (evenement.etagere === 'termine') return { avant: 'a terminé ', apres: '' };
				if (evenement.etagere === 'en_cours') return { avant: 'a commencé ', apres: '' };
				return { avant: 'veut découvrir ', apres: '' };
			case 'avancement':
				if (evenement.etagere === 'termine') return { avant: 'a terminé ', apres: '' };
				if (evenement.etagere === 'en_cours') return { avant: 's’est remis à ', apres: '' };
				if (evenement.etagere === 'a_decouvrir') {
					return { avant: 'a reposé ', apres: ' en « à découvrir »' };
				}
				return evenement.position === null
					? { avant: 'avance dans ', apres: '' }
					: { avant: `en est à ${pourcent(evenement.position)} de `, apres: '' };
			case 'abandon':
				return { avant: 'a abandonné ', apres: '' };
			case 'note':
				return {
					avant: 'a noté ',
					apres: evenement.note === null ? '' : ` ${etoiles(evenement.note)}`
				};
			case 'avis':
				// Le fil dit qu'un avis existe. Le lire se fait sur la page de l'œuvre,
				// où R27 décide — et refuse tant qu'elle n'est pas atteinte.
				return { avant: 'a écrit un avis sur ', apres: '' };
			case 'ordre_cree':
				return { avant: 'a écrit l’ordre ', apres: '' };
			case 'ordre_suivi':
				return { avant: 'suit l’ordre ', apres: '' };
		}
	}

	/**
	 * Ce que la phrase désigne, et vers quoi elle mène quand c'est permis.
	 *
	 * `vers` est nul dans deux cas seulement : une œuvre disparue du catalogue, et
	 * un titre que R32 masque. Le second est le point — rendre un titre masqué
	 * cliquable le révélerait en un geste, et la règle n'aurait servi à rien.
	 */
	function cible(evenement: Evenement): {
		texte: string;
		vers: { quoi: 'oeuvre' | 'ordre'; id: string } | null;
	} {
		if (evenement.type === 'ordre_cree' || evenement.type === 'ordre_suivi') {
			return evenement.ordre === null
				? { texte: 'un ordre supprimé', vers: null }
				: { texte: evenement.ordre.titre, vers: { quoi: 'ordre', id: evenement.ordre.id } };
		}

		const oeuvre = evenement.oeuvre;
		return {
			texte: oeuvre.libelle,
			vers: oeuvre.id === null || oeuvre.masque ? null : { quoi: 'oeuvre', id: oeuvre.id }
		};
	}
</script>

<svelte:head><title>Le fil — readerbox</title></svelte:head>

<main class="mx-auto max-w-2xl px-6 py-16">
	<a href={resolve('/')} class="text-sm text-neutral-500 underline underline-offset-4">Retour</a>

	<h1 class="mt-6 text-2xl font-semibold tracking-tight">Le fil</h1>
	<p class="mt-2 text-sm text-neutral-500">
		Ce que le groupe lit en ce moment. Une œuvre que tu as posée sur « à découvrir » apparaît sans
		son titre — on ne te la gâche pas.
	</p>

	{#if data.notifications.length > 0}
		<section class="mt-8 rounded-md border border-neutral-200 p-4">
			<div class="flex items-baseline justify-between gap-4">
				<h2 class="text-sm font-medium">Ce qui te concerne</h2>
				<form method="POST" action="?/lu">
					<button class="text-sm text-neutral-500 underline underline-offset-4">
						Tout marquer lu
					</button>
				</form>
			</div>

			<ul class="mt-3 space-y-2">
				{#each data.notifications as notification (notification.id)}
					<li class="text-sm text-neutral-700">
						{notification.acteur} a suivi ta recommandation et a atteint
						{#if notification.oeuvre.id && !notification.oeuvre.masque}
							<a
								href={resolve('/work/[id]', { id: notification.oeuvre.id })}
								class="underline underline-offset-4">{notification.oeuvre.libelle}</a
							>
						{:else}
							{notification.oeuvre.libelle}
						{/if}
						{#if notification.nombreDOeuvres > 1}
							<span class="text-neutral-500">· {notification.nombreDOeuvres} œuvres en tout</span>
						{/if}
						<span class="text-neutral-400">· {jour(notification.quand)}</span>
					</li>
				{/each}
			</ul>
		</section>
	{/if}

	{#if data.evenements.length === 0}
		<p class="mt-8 text-sm text-neutral-500">
			Rien encore. Le fil se remplit tout seul dès que quelqu’un consigne, note ou écrit — il n’y a
			rien à y publier.
		</p>
	{:else}
		<ul class="mt-8 divide-y divide-neutral-200">
			{#each data.evenements as evenement (evenement.id)}
				{@const mots = phrase(evenement)}
				{@const quoi = cible(evenement)}
				<li class="py-3 text-sm">
					<p class="text-neutral-800">
						<span class="font-medium">{evenement.acteur}</span>
						{mots.avant}{#if quoi.vers === null}{quoi.texte}{:else if quoi.vers.quoi === 'ordre'}<a
								href={resolve('/order/[id]', { id: quoi.vers.id })}
								class="underline underline-offset-4">{quoi.texte}</a
							>{:else}<a
								href={resolve('/work/[id]', { id: quoi.vers.id })}
								class="underline underline-offset-4">{quoi.texte}</a
							>{/if}{mots.apres}
						<span class="text-neutral-400">· {jour(evenement.quand)}</span>
					</p>

					{#if evenement.provenance}
						<p class="mt-1 text-neutral-500">
							{#if evenement.provenance.ordreId}
								<a
									href={resolve('/order/[id]', { id: evenement.provenance.ordreId })}
									class="underline underline-offset-4">{evenement.provenance.libelle}</a
								>
							{:else}
								{evenement.provenance.libelle}
							{/if}
						</p>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
</main>
