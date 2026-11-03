# Producto

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Por confirmar. El producto está destinado a almacenar y consultar información de los artículos de una oficina; los roles concretos y quién administra el inventario no están definidos.

## Product Purpose

La aplicación sirve como base de datos para registrar, organizar y monitorear los artículos de una oficina por secciones. El objetivo es que la información sea fácil de entender y visualizar. El usuario también señala que el producto incluye una integración con una API de IA; el uso concreto de IA aún no está definido.

## Positioning

No se ha confirmado un diferenciador frente a otras herramientas de inventario.

## Operating Context

Se usará con mayor frecuencia en un ordenador y también en dispositivos móviles. El proyecto actual es una aplicación web Next.js; no se ha confirmado si además se distribuirá como aplicación instalable de escritorio ni cómo se accederá desde móviles.

## Capabilities and Constraints

- Los registros de inventario se almacenan en Supabase. Se deben preservar los datos existentes y evitar cambios destructivos sin autorización explícita.
- El esquema actual incluye etiqueta, artículo, marca, modelo, serie, área, persona asignada, cantidad, observaciones y origen.
- La interfaz existente permite consultar y buscar registros, agruparlos por persona o área y ver un resumen del inventario.
- La navegación muestra Inventario, Personas, Chat, Avisos, Equipos y Áreas. El alcance y funcionamiento de cada sección, así como las funciones de monitoreo, están por confirmar.
- La conexión y las tareas concretas de la API de IA están por confirmar. El repositorio incluye código auxiliar para generar imágenes con DALL·E y Midjourney, pero no está confirmado que esa sea la integración prevista para los flujos de inventario.
- La interfaz actual lee registros de Supabase; las operaciones de alta, edición y eliminación desde la aplicación no están confirmadas.

## Brand Commitments

La interfaz debe ser fácil de entender y visualizar. El usuario solicita una experiencia moderna y minimalista, con modo claro y modo oscuro.

## Evidence on Hand

- El esquema de Supabase está en `supabase/20261020000000_esquema_inicial.sql`; define la tabla `inventario` y políticas RLS para usuarios autenticados.
- La pantalla actual lee datos de Supabase desde `app/page.tsx` y los presenta en `app/inventory-view.tsx`.
- No se proporcionaron testimonios, métricas, clientes, ni otros materiales de prueba. No inventarlos.

## Product Principles

- Preservar la integridad de los datos de inventario existentes.
- Hacer que los artículos sean fáciles de localizar y comprender por secciones, áreas y personas.
- Mantener la información de inventario clara y fácil de visualizar.
