<script lang="ts">
	import './layout.css';
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import favicon from '$lib/assets/favicon.svg';
	import type { LayoutProps } from './$types';

	let { data, children }: LayoutProps = $props();

	/**
	 * La navigation persistante — la seule chose qui reste à l'écran d'une page
	 * à l'autre.
	 *
	 * Elle remplace les liens « Retour » que chaque page se posait pour elle
	 * seule. Un « Retour » dit d'où l'on vient ; il ne dit jamais où l'on peut
	 * aller, et un produit qui a six surfaces sans barre oblige à repasser par
	 * l'accueil pour changer de sujet.
	 *
	 * Elle ne s'affiche qu'à un membre connecté : hors du groupe, il n'y a rien
	 * à parcourir, et une barre de six liens qui mènent tous à un refus serait
	 * une promesse fausse.
	 */
	const ENTREES = $derived(
		data.membre === null
			? []
			: [
					{ href: resolve('/search'), libelle: 'Chercher' },
					{ href: resolve('/orders'), libelle: 'Les ordres' },
					{ href: resolve('/feed'), libelle: 'Le fil' },
					{ href: resolve('/graph'), libelle: 'Ton graphe' },
					{ href: resolve('/member/[id]', { id: data.membre.id }), libelle: 'Ton journal' },
					{ href: resolve('/invitations'), libelle: 'Inviter' }
				]
	);

	/**
	 * La surface courante, pour la marquer.
	 *
	 * La comparaison porte sur le préfixe et non sur l'égalité : la page d'un
	 * ordre appartient aux ordres, et le journal d'un membre au journal.
	 */
	function courante(href: string): boolean {
		return page.url.pathname === href || page.url.pathname.startsWith(`${href}/`);
	}
</script>

<svelte:head><link rel="icon" href={favicon} /></svelte:head>

<div class="flex min-h-svh flex-col">
	<header class="sticky top-0 z-30 border-b border-trait bg-salle/95 backdrop-blur">
		<div class="mx-auto flex max-w-6xl items-center gap-6 px-5 py-3">
			<a
				href={resolve('/')}
				class="shrink-0 font-display text-lg leading-none font-medium tracking-[0.22em] text-encre
					uppercase"
			>
				readerbox
			</a>

			{#if data.membre}
				<!-- Le débordement se fait au doigt : pas de menu replié, donc pas de
				     script pour l'ouvrir. -->
				<nav
					aria-label="Les surfaces"
					class="-mx-2 min-w-0 flex-1 [scrollbar-width:none] overflow-x-auto px-2"
				>
					<ul class="flex items-center gap-5">
						{#each ENTREES as entree (entree.href)}
							<li>
								<a
									href={entree.href}
									aria-current={courante(entree.href) ? 'page' : undefined}
									class="inline-block border-b py-1 text-sm whitespace-nowrap transition-colors
										hover:text-encre
										{courante(entree.href) ? 'border-encre text-encre' : 'border-transparent text-encre-basse'}"
								>
									{entree.libelle}
								</a>
							</li>
						{/each}
					</ul>
				</nav>

				<form method="POST" action="{resolve('/')}?/deconnexion" class="shrink-0">
					<button class="text-sm text-encre-tenue transition-colors hover:text-encre">
						Sortir
					</button>
				</form>
			{/if}
		</div>
	</header>

	{@render children()}
</div>
