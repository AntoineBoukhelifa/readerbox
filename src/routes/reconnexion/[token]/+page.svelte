<script lang="ts">
	import { resolve } from '$app/paths';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const explications: Record<string, string> = {
		introuvable: 'Ce lien n’existe pas. Il a peut-être été mal recopié.',
		consommé: 'Ce lien a déjà servi. Chaque lien de reconnexion ne vaut qu’une fois.',
		révoqué: 'Ce lien a été remplacé par un plus récent.',
		expiré: 'Ce lien a expiré. Ils ne durent qu’une heure.',
		'membre parti': 'Ce compte a quitté le groupe.'
	};
</script>

<svelte:head><title>Reconnexion — readerbox</title></svelte:head>

<main class="mx-auto flex min-h-svh max-w-md flex-col justify-center px-6 py-16">
	<h1 class="enseigne text-3xl">Ce lien ne marche plus</h1>
	<p class="text-encre-sourde mt-3">{explications[data.motif] ?? 'Lien invalide.'}</p>
	<p class="text-encre-tue mt-6 text-sm">
		Demande-en un neuf depuis un appareil où tu es encore connecté, sur la page des invitations.
	</p>
	<a href={resolve('/')} class="lien mt-8 self-start">Retour à l’accueil</a>
</main>
