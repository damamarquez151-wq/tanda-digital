#![no_std]
//! Tanda digital en Soroban (Stellar).
//!
//! Cada ronda, todos los participantes aportan la misma cantidad del token
//! configurado (XLM en testnet). Cuando aporta el último, el contrato le paga
//! el bote completo al participante en turno y avanza a la siguiente ronda.
//! El orden de turnos es el orden de la lista `participantes`.

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, token, Address, Env, Vec,
};

/// Ledgers aproximados en un día (un ledger cada ~5 segundos).
const DIA_EN_LEDGERS: u32 = 17_280;
const TTL_UMBRAL: u32 = 30 * DIA_EN_LEDGERS;
const TTL_EXTENDER_A: u32 = 60 * DIA_EN_LEDGERS;

#[contracttype]
#[derive(Clone)]
enum Clave {
    Admin,
    Token,
    Aporte,
    Participantes,
    Ronda,
    Pagados,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    YaInicializada = 1,
    NoInicializada = 2,
    NoEsParticipante = 3,
    YaAporto = 4,
    TandaTerminada = 5,
    DatosInvalidos = 6,
}

/// Resumen que consume el frontend.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Estado {
    pub ronda: u32,
    pub total_rondas: u32,
    pub aporte: i128,
    pub token: Address,
    pub participantes: Vec<Address>,
    pub pagados: Vec<Address>,
    pub beneficiario: Option<Address>,
    pub terminada: bool,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Aporte {
    #[topic]
    pub participante: Address,
    pub ronda: u32,
    pub monto: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Pago {
    #[topic]
    pub beneficiario: Address,
    pub ronda: u32,
    pub monto: i128,
}

#[contract]
pub struct Tanda;

#[contractimpl]
impl Tanda {
    /// Configura la tanda. Solo se puede llamar una vez.
    /// `aporte` va en la unidad mínima del token (1 XLM = 10_000_000).
    pub fn inicializar(
        env: Env,
        admin: Address,
        token: Address,
        aporte: i128,
        participantes: Vec<Address>,
    ) -> Result<(), Error> {
        let almacen = env.storage().instance();
        if almacen.has(&Clave::Admin) {
            return Err(Error::YaInicializada);
        }
        admin.require_auth();

        if aporte <= 0 || participantes.len() < 2 {
            return Err(Error::DatosInvalidos);
        }
        // No se permiten participantes repetidos.
        for i in 0..participantes.len() {
            for j in (i + 1)..participantes.len() {
                if participantes.get_unchecked(i) == participantes.get_unchecked(j) {
                    return Err(Error::DatosInvalidos);
                }
            }
        }

        almacen.set(&Clave::Admin, &admin);
        almacen.set(&Clave::Token, &token);
        almacen.set(&Clave::Aporte, &aporte);
        almacen.set(&Clave::Participantes, &participantes);
        almacen.set(&Clave::Ronda, &0u32);
        almacen.set(&Clave::Pagados, &Vec::<Address>::new(&env));
        almacen.extend_ttl(TTL_UMBRAL, TTL_EXTENDER_A);
        Ok(())
    }

    /// El participante deposita su aporte de la ronda actual.
    /// Si es el último en aportar, se paga el bote al beneficiario en turno.
    /// Devuelve la ronda en la que se registró el aporte.
    pub fn aportar(env: Env, participante: Address) -> Result<u32, Error> {
        participante.require_auth();

        let almacen = env.storage().instance();
        let participantes: Vec<Address> = almacen
            .get(&Clave::Participantes)
            .ok_or(Error::NoInicializada)?;
        let ronda: u32 = almacen.get(&Clave::Ronda).unwrap_or(0);

        if ronda >= participantes.len() {
            return Err(Error::TandaTerminada);
        }
        if !participantes.contains(&participante) {
            return Err(Error::NoEsParticipante);
        }

        let mut pagados: Vec<Address> = almacen
            .get(&Clave::Pagados)
            .unwrap_or(Vec::new(&env));
        if pagados.contains(&participante) {
            return Err(Error::YaAporto);
        }

        let token_id: Address = almacen.get(&Clave::Token).ok_or(Error::NoInicializada)?;
        let aporte: i128 = almacen.get(&Clave::Aporte).ok_or(Error::NoInicializada)?;
        let cliente = token::Client::new(&env, &token_id);
        let contrato = env.current_contract_address();

        cliente.transfer(&participante, &contrato, &aporte);
        pagados.push_back(participante.clone());
        Aporte {
            participante,
            ronda,
            monto: aporte,
        }
        .publish(&env);

        if pagados.len() == participantes.len() {
            let beneficiario = participantes.get_unchecked(ronda);
            let bote = aporte * i128::from(participantes.len());
            cliente.transfer(&contrato, &beneficiario, &bote);
            Pago {
                beneficiario,
                ronda,
                monto: bote,
            }
            .publish(&env);

            almacen.set(&Clave::Ronda, &(ronda + 1));
            pagados = Vec::new(&env);
        }

        almacen.set(&Clave::Pagados, &pagados);
        almacen.extend_ttl(TTL_UMBRAL, TTL_EXTENDER_A);
        Ok(ronda)
    }

    /// Todo lo que necesita la pantalla en una sola lectura.
    pub fn estado(env: Env) -> Result<Estado, Error> {
        let almacen = env.storage().instance();
        let participantes: Vec<Address> = almacen
            .get(&Clave::Participantes)
            .ok_or(Error::NoInicializada)?;
        let ronda: u32 = almacen.get(&Clave::Ronda).unwrap_or(0);
        let total_rondas = participantes.len();
        let terminada = ronda >= total_rondas;
        let beneficiario = if terminada {
            None
        } else {
            Some(participantes.get_unchecked(ronda))
        };

        Ok(Estado {
            ronda,
            total_rondas,
            aporte: almacen.get(&Clave::Aporte).ok_or(Error::NoInicializada)?,
            token: almacen.get(&Clave::Token).ok_or(Error::NoInicializada)?,
            pagados: almacen.get(&Clave::Pagados).unwrap_or(Vec::new(&env)),
            participantes,
            beneficiario,
            terminada,
        })
    }
}

mod test;
