from django.urls import path

from inventario import views

urlpatterns = [
    path("inventario/", views.inventario, name="inventario"),
    path("chat/", views.chat, name="chat"),
    path("health/", views.health, name="health"),
]
