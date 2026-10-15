#![cfg(test)]

use super::*;
use soroban_sdk::{testutils::Address as _, token, vec, Address, Env};

const APORTE: i128 = 10_0000000; // 10 XLM

struct Escenario<'a> {
    env: Env,
    tanda: TandaClient<'a>,
    token: token::Client<'a>,
    participantes: [Address; 3],
}

fn preparar<'a>() -> Escenario<'a> {
    let env = Env::default();
    env.mock_all_auths();

    let emisor = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(emisor);
    let token_id = sac.address();
    let minter = token::StellarAssetClient::new(&env, &token_id);

    let participantes = [
        Address::generate(&env),
        Address::generate(&env),
        Address::generate(&env),
    ];
    for p in participantes.iter() {
        minter.mint(p, &1_000_0000000);
    }

    let id = env.register(Tanda, ());
    let tanda = TandaClient::new(&env, &id);
    let admin = Address::generate(&env);
    tanda.inicializar(
        &admin,
        &token_id,
        &APORTE,
        &vec![
            &env,
            participantes[0].clone(),
            participantes[1].clone(),
            participantes[2].clone(),
        ],
    );

    let token = token::Client::new(&env, &token_id);
    Escenario {
        env,
        tanda,
        token,
        participantes,
    }
}

#[test]
fn paga_el_bote_cuando_todos_aportan() {
    let e = preparar();
    let [a, b, c] = &e.participantes;
    let saldo_inicial = e.token.balance(a);

    e.tanda.aportar(a);
    e.tanda.aportar(b);
    assert_eq!(e.tanda.estado().pagados.len(), 2);
    e.tanda.aportar(c);

    // A era el primer turno: puso 10 y recibió 30.
    assert_eq!(e.token.balance(a), saldo_inicial + 2 * APORTE);
    let estado = e.tanda.estado();
    assert_eq!(estado.ronda, 1);
    assert_eq!(estado.pagados.len(), 0);
    assert_eq!(estado.beneficiario, Some(b.clone()));
}

#[test]
fn no_permite_aportar_dos_veces_en_la_misma_ronda() {
    let e = preparar();
    let a = &e.participantes[0];
    e.tanda.aportar(a);
    assert_eq!(e.tanda.try_aportar(a), Err(Ok(Error::YaAporto)));
}

#[test]
fn rechaza_a_quien_no_esta_en_la_tanda() {
    let e = preparar();
    let extrano = Address::generate(&e.env);
    assert_eq!(e.tanda.try_aportar(&extrano), Err(Ok(Error::NoEsParticipante)));
}

#[test]
fn termina_despues_de_la_ultima_ronda() {
    let e = preparar();
    for _ in 0..3 {
        for p in e.participantes.iter() {
            e.tanda.aportar(p);
        }
    }
    let estado = e.tanda.estado();
    assert!(estado.terminada);
    assert_eq!(estado.beneficiario, None);
    // Al final todos quedan igual que al inicio.
    for p in e.participantes.iter() {
        assert_eq!(e.token.balance(p), 1_000_0000000);
    }
    assert_eq!(
        e.tanda.try_aportar(&e.participantes[0]),
        Err(Ok(Error::TandaTerminada))
    );
}

#[test]
fn no_se_puede_inicializar_dos_veces() {
    let e = preparar();
    let admin = Address::generate(&e.env);
    let resultado = e.tanda.try_inicializar(
        &admin,
        &e.token.address,
        &APORTE,
        &vec![&e.env, e.participantes[0].clone(), e.participantes[1].clone()],
    );
    assert_eq!(resultado, Err(Ok(Error::YaInicializada)));
}
