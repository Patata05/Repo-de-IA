---
name: Consola de inventario
description: Panel operativo oscuro con navegación lateral, superficies azul noche y acentos de datos.
colors:
  page: "#0a111d"
  sidebar: "#0d1726"
  sidebar-bottom: "#070d17"
  surface: "#121e2d"
  surface-raised: "#19283a"
  surface-soft: "#1d2c40"
  border: "#26384d"
  text: "#f2f5fa"
  muted: "#91a1b6"
  blue: "#6b8cff"
  teal: "#55d7c4"
  amber: "#f2b84b"
  purple: "#a784ff"
  red: "#ed7185"
typography:
  display:
    fontFamily: "Inter, Segoe UI, sans-serif"
    fontSize: "clamp(24px, 2.2vw, 29px)"
    fontWeight: 690
    lineHeight: 1.2
    letterSpacing: "-0.045em"
  title:
    fontFamily: "Inter, Segoe UI, sans-serif"
    fontSize: "14px"
    fontWeight: 650
  body:
    fontFamily: "Inter, Segoe UI, sans-serif"
    fontSize: "14px"
rounded:
  control: "10px"
  card: "14px"
  panel: "15px"
spacing:
  sm: "8px"
  md: "16px"
  lg: "24px"
components:
  sidebar:
    backgroundColor: "{colors.sidebar}"
    width: "252px"
  panel:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.panel}"
  inventory-table:
    backgroundColor: "{colors.surface}"
    minWidth: "1120px"
    horizontalScroll: true
---

# Sistema de diseño: Consola de inventario

## Dirección visual

**Estrella Polar Creativa: “Centro de operaciones nocturno”**

Un panel de control para localizar y revisar registros de oficina con rapidez. La interfaz toma de la referencia visual una navegación lateral persistente, una barra superior compacta, métricas resumidas y una tabla densa. El fondo azul noche y las superficies elevadas separan áreas de trabajo sin competir con los datos.

El modo oscuro es el inicio predeterminado. El modo claro conserva la misma estructura y jerarquía, con superficies claras y tinta verde oscura. La elección se guarda en el navegador.

### Características

- Navegación lateral etiquetada en escritorio y barra inferior de seis accesos en móvil.
- Búsqueda persistente en la barra superior.
- Cuatro indicadores derivados exclusivamente de los registros actuales: artículos, unidades, áreas y asignaciones.
- Vista de inventario deliberadamente sin gráficas; el resumen y la tabla priorizan la consulta directa de registros.
- Tabla con los diez campos de inventario y desplazamiento horizontal en pantallas estrechas.
- Paneles sólidos y contornos finos; el contraste y la lectura de datos prevalecen sobre los efectos decorativos.

## Color

El modo oscuro conserva su combinación de azul noche e índigo. El modo claro usa la paleta “Verde mineral”: un fondo ligeramente cálido y verdoso (#F3F5F0), paneles casi blancos (#FCFDFB), texto verde tinta (#20352C) y verde profundo (#28634F) para navegación, foco y acciones. La barra lateral transita de verde grisáceo claro (#E6ECE4) a (#EDF1EA); las superficies elevadas usan (#F6F8F3) y las suaves (#E8EEE7), con separadores (#D7E1D8).

El fondo incorpora halos difuminados y lentos: azul y verde en modo oscuro, solo verdes en modo claro. Se mueven y aparecen/desaparecen durante ciclos de 32–42 segundos, sin tapar el contenido; se pausan al ocultar la pestaña y respetan `prefers-reduced-motion`.

Los acentos de métricas mantienen roles distintos en ambos temas: verde (#28634F), verde azulado (#12685D), ámbar oscuro (#81570F) y violeta (#705598); rojo (#A44E54) queda para estados de error. El texto secundario del modo claro es (#4C6254). Estos pares de texto superan 4.5:1 sobre las superficies claras definidas. Las selecciones de fila, el foco, el logotipo y la selección de texto también cambian al verde para evitar restos de azul índigo en el tema claro.

**Regla de datos reales:** no mostrar valor monetario, niveles de stock, alertas, movimientos de salida ni otras métricas que el esquema disponible no permite calcular.

## Tipografía

Sans serif de interfaz con títulos compactos, etiquetas discretas y números tabulares para facilitar la comparación. Los encabezados llevan peso y contraste, no texto decorativo ni gradientes.

## Composición y componentes

- **Navegación:** barra izquierda de 252 px en escritorio; barra inferior fija con los mismos destinos en móvil.
- **Cabecera:** búsqueda amplia y control de tema; acciones sin función no se muestran.
- **Indicadores:** cuatro paneles amplios con espacio generoso; cada cifra conserva una etiqueta y una descripción verificable. En móvil reducen su altura y mantienen una cuadrícula de dos columnas.
- **Resumen:** cifras de artículos, unidades, áreas y asignaciones; no se muestran gráficas.
- **Grupos:** tarjetas seleccionables de personas o áreas, con mayor ancho y área de toque, que filtran los registros visibles. En móvil se apilan a ancho completo.
- **Tabla:** diez columnas en el orden existente, bordes horizontales sutiles y scroll horizontal sin ocultar campos.
- **Chat y avisos:** mantienen las interacciones y los estados existentes, con superficies y acentos adaptados a cada tema.

## Accesibilidad y adaptación

- Foco de teclado visible y controles con nombres accesibles.
- Contraste suficiente en superficies oscuras y claras, sin depender solo del color para comunicar datos.
- Respeto a `prefers-reduced-motion`.
- En pantallas móviles, navegación inferior y tabla desplazable; los campos no se reordenan ni se eliminan.
- Los indicadores conservan una proporción equilibrada en escritorio y dos columnas en móvil; las tarjetas de grupo crecen en escritorio y permanecen cómodas al tacto en móvil.
- El resumen y la tabla conservan etiquetas accesibles y estados claros cuando no hay registros.
