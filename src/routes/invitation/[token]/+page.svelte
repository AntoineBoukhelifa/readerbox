<script lang="ts">
	import { resolve } from '$app/paths';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const explications: Record<string, string> = {
		introuvable: 'Ce lien n’existe pas. Il a peut-être été mal recopié.',
		consommée: 'Ce lien a déjà servi. Chaque invitation ne vaut qu’une fois.',
		révoquée: 'Ce lien a été révoqué par la personne qui l’a émis.',
		expirée: 'Ce lien a expiré. Demande-en un nouveau.'
	};
</script>

<svelte:head><title>Rejoindre — readerbox</title></svelte:head>

<main class="mx-auto flex w-full max-w-md flex-1 flex-col justify-center px-5 py-16">
	{#if data.etat === 'valide'}
		<h1 class="font-display text-3xl leading-none tracking-tight">On t’attendait</h1>
		<p class="mt-3 text-sm leading-relaxed text-encre-basse">
			Choisis le nom sous lequel le groupe te verra. Tu pourras le changer plus tard.
		</p>

		<form method="POST" class="mt-8 flex flex-col gap-4">
			<label class="flex flex-col gap-1.5">
				<span class="enseigne">Ton nom</span>
				<input name="nom" required minlength="2" autocomplete="nickname" class="champ w-full" />
			</label>

			{#if form?.message}
				<p class="border-l-2 border-braise pl-4 text-sm text-encre-basse">{form.message}</p>
			{/if}

			<div><button type="submit" class="action">Rejoindre le groupe</button></div>
		</form>
	{:else}
		<h1 class="font-display text-3xl leading-none tracking-tight">Ce lien ne marche plus</h1>
		<p class="mt-3 text-sm text-encre-basse">{explications[data.etat] ?? 'Lien invalide.'}</p>
		<p class="mt-6"><a href={resolve('/')} class="lien text-sm">Retour à l’accueil</a></p>
	{/if}
</main>
