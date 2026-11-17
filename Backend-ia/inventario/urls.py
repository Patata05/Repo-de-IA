from django.urls import path

from inventario import views

urlpatterns = [
    path("inventario/", views.inventario, name="inventario"),
    path("chat/", views.chat, name="chat"),
    path("chat/n8n/", views.chat_n8n, name="chat_n8n"),
    path("chat/compose/", views.chat_compose, name="chat_compose"),
    path("chat/reiniciar/", views.chat_reiniciar, name="chat_reiniciar"),
    path("health/", views.health, name="health"),
]
